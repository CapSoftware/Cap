use crate::{
    feeds::microphone::{self, MicrophoneFeedLock},
    output_pipeline::{AudioFrame, AudioSource, PipelineHealthEvent, emit_health},
    sources::audio_mixer::AudioMixer,
};
use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cpal::SampleFormat;
use futures::{SinkExt, channel::mpsc};
use kameo::error::SendError;
use std::{
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
        let input_samples = input_frame.samples();

        let target = *self.context.output();
        let src_rate = source_rate.max(1) as u64;
        let dst_rate = target.rate.max(1) as u64;
        let pending_output_samples = self
            .context
            .delay()
            .map(|d| d.output.max(0) as u64)
            .unwrap_or(0);
        let resampled_from_input = (input_samples as u64)
            .saturating_mul(dst_rate)
            .div_ceil(src_rate);
        let capacity = pending_output_samples
            .saturating_add(resampled_from_input)
            .saturating_add(16)
            .min(i32::MAX as u64) as usize;

        let mut output = ffmpeg::frame::Audio::new(target.format, capacity, target.channel_layout);

        if self.context.run(&input_frame, &mut output).is_err() {
            return None;
        }

        if output.samples() == 0 {
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
            let audio_info = source_info
                .with_max_channels(MICROPHONE_TARGET_CHANNELS)
                .with_sample_rate(AudioMixer::INFO.sample_rate)
                .with_sample_format(AudioMixer::INFO.sample_format)
                .with_channels(MICROPHONE_TARGET_CHANNELS as usize);
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
                .ask(microphone::AddRecordingSender {
                    sender: tx,
                    health_tx: health_tx.clone(),
                    label: "microphone-feed:recording".to_string(),
                })
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

            info!(
                device = %device_name,
                source_rate = source_info.sample_rate,
                source_channels = source_info.channels,
                source_format = ?source_info.sample_format,
                target_rate = audio_info.sample_rate,
                target_channels = audio_info.channels,
                target_format = ?audio_info.sample_format,
                "Microphone source configured"
            );

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
                    let mut logged_current_source: Option<(u32, u16, SampleFormat)> = None;

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

                                let target_matches_source = frame.sample_rate
                                    == audio_info.sample_rate
                                    && frame.channels as usize == audio_info.channels
                                    && ffmpeg_sample_format_for(frame.format)
                                        == Some(audio_info.sample_format);

                                let resampler_matches = resampler.as_ref().is_some_and(|r| {
                                    r.matches(frame.sample_rate, frame.channels, frame.format)
                                });

                                if !target_matches_source && !resampler_matches {
                                    let previous_source = logged_current_source;
                                    let new_source =
                                        (frame.sample_rate, frame.channels, frame.format);
                                    if previous_source.is_none() {
                                        info!(
                                            source_rate = new_source.0,
                                            source_channels = new_source.1,
                                            source_format = ?new_source.2,
                                            target_rate = audio_info.sample_rate,
                                            target_channels = audio_info.channels,
                                            target_format = ?audio_info.sample_format,
                                            "Microphone: creating resampler for source→target"
                                        );
                                    } else {
                                        info!(
                                            old = ?previous_source,
                                            new = ?new_source,
                                            "Microphone format changed mid-stream, rebuilding resampler"
                                        );
                                    }
                                    resampler = MicResampler::create(
                                        frame.sample_rate,
                                        frame.channels,
                                        frame.format,
                                        &audio_info,
                                    );
                                    logged_current_source = Some(new_source);
                                } else if target_matches_source && resampler.is_some() {
                                    info!(
                                        "Microphone source now matches target, dropping resampler"
                                    );
                                    resampler = None;
                                    logged_current_source =
                                        Some((frame.sample_rate, frame.channels, frame.format));
                                }

                                let audio_frame = if let Some(ref mut ctx) = resampler {
                                    ctx.resample(
                                        &frame.data,
                                        frame.sample_rate,
                                        frame.channels,
                                        frame.format,
                                        frame.timestamp,
                                    )
                                } else {
                                    Some(AudioFrame::new(
                                        audio_info.wrap_frame(&frame.data),
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

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::{Sample, Type};

    #[test]
    fn target_info_uses_output_rate_and_mono() {
        let device_info = AudioInfo {
            sample_format: Sample::F32(Type::Packed),
            sample_rate: 32000,
            channels: 2,
            time_base: cap_media_info::FFRational(1, 1_000_000),
            buffer_size: 1024,
            is_wireless_transport: false,
        };

        let target = device_info
            .with_max_channels(MICROPHONE_TARGET_CHANNELS)
            .with_sample_rate(AudioMixer::INFO.sample_rate)
            .with_sample_format(AudioMixer::INFO.sample_format)
            .with_channels(MICROPHONE_TARGET_CHANNELS as usize);

        assert_eq!(target.sample_rate, 48000);
        assert_eq!(target.channels, 1);
        assert_eq!(target.sample_format, AudioMixer::INFO.sample_format);
    }

    #[test]
    fn resampler_detects_mismatch_between_source_and_target() {
        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);

        assert!(MicResampler::create(32000, 1, SampleFormat::F32, &target).is_some());
        assert!(MicResampler::create(44100, 2, SampleFormat::I16, &target).is_some());
        assert!(MicResampler::create(96000, 2, SampleFormat::F32, &target).is_some());
    }

    #[test]
    fn resampler_matches_detects_same_source() {
        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let resampler =
            MicResampler::create(32000, 1, SampleFormat::F32, &target).expect("resampler");
        assert!(resampler.matches(32000, 1, SampleFormat::F32));
        assert!(!resampler.matches(48000, 1, SampleFormat::F32));
        assert!(!resampler.matches(32000, 2, SampleFormat::F32));
        assert!(!resampler.matches(32000, 1, SampleFormat::I16));
    }

    #[test]
    fn upsampling_preserves_total_duration() {
        use cap_timestamp::{MachAbsoluteTimestamp, Timestamp};

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(32000, 2, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 1024;
        const FRAME_COUNT: usize = 64;
        const CHANNELS: usize = 2;

        let ts = Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::now());

        let payload_len_bytes = FRAME_SAMPLES * CHANNELS * std::mem::size_of::<f32>();
        let payload = vec![0u8; payload_len_bytes];

        let mut produced: u64 = 0;
        for _ in 0..FRAME_COUNT {
            if let Some(frame) = resampler.resample(&payload, 32000, 2, SampleFormat::F32, ts) {
                produced += frame.samples() as u64;
            }
        }

        let consumed_input_samples = (FRAME_SAMPLES * FRAME_COUNT) as u64;
        let expected_output_samples = consumed_input_samples * 48_000 / 32_000;

        let lower_bound = expected_output_samples * 99 / 100;
        assert!(
            produced >= lower_bound,
            "upsampling lost samples: produced={produced}, expected≈{expected_output_samples}, \
             lower_bound={lower_bound}"
        );
    }

    #[test]
    fn downsampling_preserves_total_duration() {
        use cap_timestamp::{MachAbsoluteTimestamp, Timestamp};

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(96000, 2, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 1024;
        const FRAME_COUNT: usize = 64;
        const CHANNELS: usize = 2;

        let ts = Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::now());
        let payload_len_bytes = FRAME_SAMPLES * CHANNELS * std::mem::size_of::<f32>();
        let payload = vec![0u8; payload_len_bytes];

        let mut produced: u64 = 0;
        for _ in 0..FRAME_COUNT {
            if let Some(frame) = resampler.resample(&payload, 96000, 2, SampleFormat::F32, ts) {
                produced += frame.samples() as u64;
            }
        }

        let consumed_input_samples = (FRAME_SAMPLES * FRAME_COUNT) as u64;
        let expected_output_samples = consumed_input_samples * 48_000 / 96_000;

        let lower_bound = expected_output_samples * 99 / 100;
        assert!(
            produced >= lower_bound,
            "downsampling lost samples: produced={produced}, expected≈{expected_output_samples}, \
             lower_bound={lower_bound}"
        );
    }
}
