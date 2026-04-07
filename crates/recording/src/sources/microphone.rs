use crate::{
    feeds::microphone::{self, MicrophoneFeedLock},
    output_pipeline::{AudioFrame, AudioSource, PipelineHealthEvent, emit_health},
};
use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cpal::SampleFormat;
use futures::{SinkExt, channel::mpsc};
use kameo::error::SendError;
use std::{
    borrow::Cow,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

const MICROPHONE_TARGET_CHANNELS: u16 = 1;

const SILENCE_TIMEOUT_WIRED: Duration = Duration::from_millis(100);
const SILENCE_TIMEOUT_WIRELESS: Duration = Duration::from_millis(200);
const SILENCE_CHUNK_DURATION: Duration = Duration::from_millis(20);
const MIC_RECONNECT_AFTER: Duration = Duration::from_secs(2);
const MIC_RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(30);

pub struct Microphone {
    info: AudioInfo,
    _lock: Arc<MicrophoneFeedLock>,
    cancel: CancellationToken,
}

#[derive(Debug, Error)]
pub enum MicrophoneSourceError {
    #[error("microphone actor not running")]
    ActorNotRunning,
    #[error("failed to add microphone sender: {0}")]
    AddSenderFailed(SendError<()>),
}

struct MicResampler {
    context: ffmpeg::software::resampling::Context,
    source_rate: u32,
    source_channels: u16,
    source_format: SampleFormat,
}

impl MicResampler {
    fn create(
        source_rate: u32,
        source_channels: u16,
        source_format: SampleFormat,
        target_info: &AudioInfo,
    ) -> Option<Self> {
        let ffmpeg_fmt = ffmpeg_sample_format_for(source_format)?;
        let source_info = AudioInfo::new_raw(
            ffmpeg_fmt,
            source_rate,
            source_channels.min(AudioInfo::MAX_AUDIO_CHANNELS),
        );

        let context = ffmpeg::software::resampler(
            (
                source_info.sample_format,
                source_info.channel_layout(),
                source_info.sample_rate,
            ),
            (
                target_info.sample_format,
                target_info.channel_layout(),
                target_info.sample_rate,
            ),
        )
        .ok()?;

        Some(Self {
            context,
            source_rate,
            source_channels,
            source_format,
        })
    }

    fn matches(&self, rate: u32, channels: u16, format: SampleFormat) -> bool {
        self.source_rate == rate && self.source_channels == channels && self.source_format == format
    }

    fn resample(
        &mut self,
        data: &[u8],
        source_rate: u32,
        source_channels: u16,
        source_format: SampleFormat,
        timestamp: cap_timestamp::Timestamp,
    ) -> Option<AudioFrame> {
        let ffmpeg_fmt = ffmpeg_sample_format_for(source_format)?;
        let source_info = AudioInfo::new_raw(
            ffmpeg_fmt,
            source_rate,
            source_channels.min(AudioInfo::MAX_AUDIO_CHANNELS),
        );

        let input_frame = source_info.wrap_frame(data);
        let mut output = ffmpeg::frame::Audio::empty();

        if self.context.run(&input_frame, &mut output).is_err() {
            return None;
        }

        Some(AudioFrame::new(output, timestamp))
    }
}

impl AudioSource for Microphone {
    type Config = Arc<MicrophoneFeedLock>;

    #[allow(clippy::manual_async_fn)]
    fn setup(
        feed_lock: Self::Config,
        mut audio_tx: mpsc::Sender<AudioFrame>,
        ctx: &mut crate::SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        let health_tx = ctx.health_tx().clone();
        async move {
            let source_info = feed_lock.audio_info();
            let audio_info = source_info.with_max_channels(MICROPHONE_TARGET_CHANNELS);
            let source_channels = source_info.channels;
            let target_channels = audio_info.channels;
            let is_wireless = source_info.is_wireless_transport;
            let device_name = feed_lock.device_name().to_string();
            let cancel = CancellationToken::new();
            let (tx, rx) = flume::bounded(128);

            let send_timeout = if is_wireless {
                Duration::from_millis(20)
            } else {
                Duration::from_millis(5)
            };

            feed_lock
                .ask(microphone::AddSender(tx))
                .await
                .map_err(|err| match err {
                    SendError::ActorNotRunning(_) => MicrophoneSourceError::ActorNotRunning,
                    other => MicrophoneSourceError::AddSenderFailed(other.map_msg(|_| ())),
                })?;

            let mic_frame_counter = Arc::new(AtomicU64::new(0));
            let mic_drop_counter = Arc::new(AtomicU64::new(0));
            let mic_silence_counter = Arc::new(AtomicU64::new(0));

            let silence_timeout = if is_wireless {
                SILENCE_TIMEOUT_WIRELESS
            } else {
                SILENCE_TIMEOUT_WIRED
            };

            let silence_chunk_samples =
                (audio_info.rate() as f64 * SILENCE_CHUNK_DURATION.as_secs_f64()).ceil() as usize;

            let original_rate = source_info.sample_rate;
            let original_channels = source_info.channels as u16;

            tokio::spawn({
                let frame_counter = mic_frame_counter.clone();
                let drop_counter = mic_drop_counter.clone();
                let silence_counter = mic_silence_counter.clone();
                let feed_lock = feed_lock.clone();
                let device_name = device_name.clone();
                let health_tx = health_tx.clone();
                let cancel = cancel.clone();
                async move {
                    let mut resampler: Option<MicResampler> = None;
                    let mut silence_mode = false;
                    let mut silence_start: Option<Instant> = None;
                    let reconnect_in_flight = Arc::new(AtomicBool::new(false));
                    let mut reconnect_attempts: u32 = 0;
                    let mut next_reconnect_after = MIC_RECONNECT_AFTER;
                    let mut last_timestamp: Option<cap_timestamp::Timestamp> = None;
                    let mut last_frame_duration = SILENCE_CHUNK_DURATION;

                    loop {
                        let recv_result = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => break,
                            r = tokio::time::timeout(silence_timeout, rx.recv_async()) => r,
                        };
                        match recv_result {
                            Ok(Ok(frame)) => {
                                if silence_mode {
                                    let stall_ms =
                                        silence_start.map(|s| s.elapsed().as_millis()).unwrap_or(0);
                                    info!(
                                        stall_ms,
                                        reconnect_attempts, "Microphone data resumed after silence"
                                    );
                                    silence_mode = false;
                                    silence_start = None;
                                    reconnect_in_flight.store(false, Ordering::Relaxed);
                                    reconnect_attempts = 0;
                                    next_reconnect_after = MIC_RECONNECT_AFTER;
                                    emit_health(&health_tx, PipelineHealthEvent::SourceRestarted);
                                }

                                let format_changed = frame.sample_rate != original_rate
                                    || frame.channels != original_channels;

                                let needs_resampling = if format_changed {
                                    match &resampler {
                                        Some(r)
                                            if r.matches(
                                                frame.sample_rate,
                                                frame.channels,
                                                frame.format,
                                            ) =>
                                        {
                                            true
                                        }
                                        Some(_) | None => {
                                            info!(
                                                old_rate = original_rate,
                                                new_rate = frame.sample_rate,
                                                old_channels = original_channels,
                                                new_channels = frame.channels,
                                                "Microphone format changed, creating resampler"
                                            );
                                            resampler = MicResampler::create(
                                                frame.sample_rate,
                                                frame.channels,
                                                frame.format,
                                                &audio_info,
                                            );
                                            resampler.is_some()
                                        }
                                    }
                                } else {
                                    if resampler.is_some() {
                                        info!(
                                            "Microphone format restored to original, dropping resampler"
                                        );
                                        resampler = None;
                                    }
                                    false
                                };

                                let audio_frame = if needs_resampling {
                                    if let Some(ref mut ctx) = resampler {
                                        ctx.resample(
                                            &frame.data,
                                            frame.sample_rate,
                                            frame.channels,
                                            frame.format,
                                            frame.timestamp,
                                        )
                                    } else {
                                        None
                                    }
                                } else {
                                    let packed = maybe_downmix_channels(
                                        &frame.data,
                                        frame.format,
                                        source_channels,
                                        target_channels,
                                    );
                                    Some(AudioFrame::new(
                                        audio_info.wrap_frame(packed.as_ref()),
                                        frame.timestamp,
                                    ))
                                };

                                let Some(audio_frame) = audio_frame else {
                                    drop_counter.fetch_add(1, Ordering::Relaxed);
                                    continue;
                                };

                                let sample_count = audio_frame.samples();
                                last_frame_duration = Duration::from_secs_f64(
                                    sample_count as f64 / audio_info.rate() as f64,
                                );
                                last_timestamp = Some(frame.timestamp);

                                match tokio::time::timeout(send_timeout, audio_tx.send(audio_frame))
                                    .await
                                {
                                    Ok(Ok(())) => {
                                        frame_counter.fetch_add(1, Ordering::Relaxed);
                                    }
                                    _ => {
                                        drop_counter.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            }
                            Ok(Err(_)) => {
                                debug!("Microphone feed channel closed");
                                break;
                            }
                            Err(_) => {
                                let stall_started = *silence_start.get_or_insert_with(Instant::now);
                                let stall_duration = stall_started.elapsed();

                                if !silence_mode {
                                    warn!(
                                        is_wireless,
                                        timeout_ms = silence_timeout.as_millis(),
                                        "Microphone data timeout, generating silence"
                                    );
                                    silence_mode = true;
                                }

                                if !reconnect_in_flight.load(Ordering::Relaxed)
                                    && stall_duration >= next_reconnect_after
                                {
                                    reconnect_attempts += 1;
                                    warn!(
                                        attempt = reconnect_attempts,
                                        backoff_secs = next_reconnect_after.as_secs(),
                                        stall_secs = stall_duration.as_secs(),
                                        "Microphone stalled, attempting reconnect"
                                    );
                                    emit_health(&health_tx, PipelineHealthEvent::SourceRestarting);
                                    reconnect_in_flight.store(true, Ordering::Relaxed);

                                    let feed = feed_lock.clone();
                                    let name = device_name.clone();
                                    let in_flight = reconnect_in_flight.clone();
                                    tokio::spawn(async move {
                                        let ready = match feed
                                            .ask(microphone::SetInput { label: name })
                                            .await
                                        {
                                            Ok(r) => r,
                                            Err(e) => {
                                                warn!("Microphone reconnect failed: {e}");
                                                in_flight.store(false, Ordering::Relaxed);
                                                return;
                                            }
                                        };
                                        match ready.await {
                                            Ok(_) => {
                                                info!("Microphone reconnect stream ready")
                                            }
                                            Err(e) => {
                                                warn!("Microphone reconnect stream failed: {e}");
                                                in_flight.store(false, Ordering::Relaxed);
                                            }
                                        }
                                    });

                                    next_reconnect_after =
                                        (next_reconnect_after * 2).min(MIC_RECONNECT_BACKOFF_MAX);
                                    silence_start = Some(Instant::now());
                                }

                                let timestamp = match last_timestamp {
                                    Some(ts) => {
                                        let next = ts + last_frame_duration;
                                        last_timestamp = Some(next);
                                        last_frame_duration = Duration::from_secs_f64(
                                            silence_chunk_samples as f64 / audio_info.rate() as f64,
                                        );
                                        next
                                    }
                                    None => {
                                        continue;
                                    }
                                };

                                let silence_frame =
                                    create_silence_frame(&audio_info, silence_chunk_samples);
                                let audio_frame = AudioFrame::new(silence_frame, timestamp);

                                silence_counter.fetch_add(1, Ordering::Relaxed);

                                if let Ok(Ok(())) =
                                    tokio::time::timeout(send_timeout, audio_tx.send(audio_frame))
                                        .await
                                {}
                            }
                        }
                    }
                }
            });

            tokio::spawn({
                let cancel = cancel.clone();
                async move {
                    let frame_counter = mic_frame_counter;
                    let drop_counter = mic_drop_counter;
                    let silence_counter = mic_silence_counter;
                    let mut last_log = Instant::now();
                    let mut prev_captured: u64 = 0;
                    let mut prev_dropped: u64 = 0;
                    let mut stale_count: u32 = 0;
                    loop {
                        tokio::select! {
                            biased;
                            _ = cancel.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                        }
                        let captured = frame_counter.load(Ordering::Relaxed);
                        let dropped = drop_counter.load(Ordering::Relaxed);
                        let silence = silence_counter.load(Ordering::Relaxed);

                        if (dropped > 0 || silence > 0)
                            && last_log.elapsed() >= Duration::from_secs(5)
                        {
                            let total = captured + dropped;
                            let drop_pct = if total > 0 {
                                100.0 * dropped as f64 / total as f64
                            } else {
                                0.0
                            };

                            let data_changed = captured != prev_captured || dropped != prev_dropped;
                            prev_captured = captured;
                            prev_dropped = dropped;

                            if !data_changed {
                                stale_count = stale_count.saturating_add(1);
                            } else {
                                stale_count = 0;
                            }

                            if stale_count <= 2 {
                                warn!(
                                    captured,
                                    dropped,
                                    silence_frames = silence,
                                    drop_pct = format!("{:.1}%", drop_pct),
                                    is_wireless,
                                    "Microphone audio stats"
                                );
                            } else if stale_count.is_multiple_of(12) {
                                warn!(
                                    captured,
                                    dropped,
                                    silence_frames = silence,
                                    drop_pct = format!("{:.1}%", drop_pct),
                                    is_wireless,
                                    stale_intervals = stale_count,
                                    "Microphone audio stats (stalled)"
                                );
                            }
                            last_log = Instant::now();
                        } else if captured > 0 {
                            debug!(captured, "Microphone audio frames forwarded");
                        }
                    }
                }
            });

            Ok(Self {
                info: audio_info,
                _lock: feed_lock,
                cancel,
            })
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> + Send {
        self.cancel.cancel();
        async { Ok(()) }
    }
}

fn create_silence_frame(info: &AudioInfo, sample_count: usize) -> ffmpeg::frame::Audio {
    let mut frame =
        ffmpeg::frame::Audio::new(info.sample_format, sample_count, info.channel_layout());

    for i in 0..frame.planes() {
        frame.data_mut(i).fill(0);
    }

    frame.set_rate(info.rate() as u32);
    frame
}

fn maybe_downmix_channels<'a>(
    data: &'a [u8],
    format: SampleFormat,
    source_channels: usize,
    target_channels: usize,
) -> Cow<'a, [u8]> {
    if target_channels == 0 || source_channels == 0 || target_channels >= source_channels {
        return Cow::Borrowed(data);
    }

    if target_channels == 1 {
        if let Some(samples) = downmix_to_mono(data, format, source_channels) {
            Cow::Owned(samples)
        } else {
            Cow::Borrowed(data)
        }
    } else {
        Cow::Borrowed(data)
    }
}

fn downmix_to_mono(data: &[u8], format: SampleFormat, source_channels: usize) -> Option<Vec<u8>> {
    let sample_size = sample_format_size(format)?;

    let frame_size = sample_size.checked_mul(source_channels)?;
    if frame_size == 0 || !data.len().is_multiple_of(frame_size) {
        return None;
    }

    let frame_count = data.len() / frame_size;
    let mut out = vec![0u8; frame_count * sample_size];

    for (frame_idx, frame) in data.chunks(frame_size).enumerate() {
        let mono = average_frame_sample(format, frame, sample_size, source_channels)?;
        let start = frame_idx * sample_size;
        write_sample_from_f64(format, mono, &mut out[start..start + sample_size]);
    }

    Some(out)
}

fn sample_format_size(format: SampleFormat) -> Option<usize> {
    Some(match format {
        SampleFormat::I8 | SampleFormat::U8 => 1,
        SampleFormat::I16 | SampleFormat::U16 => 2,
        SampleFormat::I32 | SampleFormat::U32 | SampleFormat::F32 => 4,
        SampleFormat::I64 | SampleFormat::U64 | SampleFormat::F64 => 8,
        _ => return None,
    })
}

fn average_frame_sample(
    format: SampleFormat,
    frame: &[u8],
    sample_size: usize,
    channels: usize,
) -> Option<f64> {
    let mut sum = 0.0;
    for ch in 0..channels {
        let start = ch * sample_size;
        let end = start + sample_size;
        sum += sample_to_f64(format, &frame[start..end])?;
    }

    Some(sum / channels as f64)
}

fn sample_to_f64(format: SampleFormat, bytes: &[u8]) -> Option<f64> {
    match format {
        SampleFormat::I8 => bytes.first().copied().map(|v| v as i8 as f64),
        SampleFormat::U8 => bytes.first().copied().map(|v| v as f64),
        SampleFormat::I16 => {
            let mut buf = [0u8; 2];
            buf.copy_from_slice(bytes);
            Some(i16::from_ne_bytes(buf) as f64)
        }
        SampleFormat::U16 => {
            let mut buf = [0u8; 2];
            buf.copy_from_slice(bytes);
            Some(u16::from_ne_bytes(buf) as f64)
        }
        SampleFormat::I32 => {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Some(i32::from_ne_bytes(buf) as f64)
        }
        SampleFormat::U32 => {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Some(u32::from_ne_bytes(buf) as f64)
        }
        SampleFormat::I64 => {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Some(i64::from_ne_bytes(buf) as f64)
        }
        SampleFormat::U64 => {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Some(u64::from_ne_bytes(buf) as f64)
        }
        SampleFormat::F32 => {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Some(f32::from_ne_bytes(buf) as f64)
        }
        SampleFormat::F64 => {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Some(f64::from_ne_bytes(buf))
        }
        _ => None,
    }
}

fn write_sample_from_f64(format: SampleFormat, value: f64, out: &mut [u8]) {
    match format {
        SampleFormat::I8 => {
            let sample = value.round().clamp(i8::MIN as f64, i8::MAX as f64) as i8;
            out[0] = sample as u8;
        }
        SampleFormat::U8 => {
            let sample = value.round().clamp(u8::MIN as f64, u8::MAX as f64) as u8;
            out[0] = sample;
        }
        SampleFormat::I16 => {
            let sample = value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::U16 => {
            let sample = value.round().clamp(u16::MIN as f64, u16::MAX as f64) as u16;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::I32 => {
            let sample = value.round().clamp(i32::MIN as f64, i32::MAX as f64) as i32;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::U32 => {
            let sample = value.round().clamp(u32::MIN as f64, u32::MAX as f64) as u32;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::I64 => {
            let sample = value.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::U64 => {
            let sample = value.round().clamp(u64::MIN as f64, u64::MAX as f64) as u64;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::F32 => {
            let sample = value as f32;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::F64 => {
            out.copy_from_slice(&value.to_ne_bytes());
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_stereo_f32_to_mono() {
        let frames = [(0.5f32, -0.25f32), (1.0f32, 1.0f32)];
        let mut data = Vec::new();

        for (left, right) in frames {
            data.extend_from_slice(&left.to_ne_bytes());
            data.extend_from_slice(&right.to_ne_bytes());
        }

        let downmixed = maybe_downmix_channels(&data, SampleFormat::F32, 2, 1);
        let owned = downmixed.into_owned();
        assert_eq!(owned.len(), frames.len() * std::mem::size_of::<f32>());

        let first = f32::from_ne_bytes(owned[0..4].try_into().unwrap());
        let second = f32::from_ne_bytes(owned[4..8].try_into().unwrap());

        assert!((first - 0.125).abs() < f32::EPSILON);
        assert!((second - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn leaves_mono_buffers_untouched() {
        let sample = 0.75f32;
        let data = sample.to_ne_bytes().to_vec();
        let result = maybe_downmix_channels(&data, SampleFormat::F32, 1, 1);
        assert!(matches!(result, Cow::Borrowed(_)));
    }
}
