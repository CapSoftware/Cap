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

// A stalled callback usually means CoreAudio/cpal is delivering buffers late, not that
// audio was lost: the real samples arrive with their original capture timestamps once the
// thread resumes. Fabricating forward-timestamped silence for those transient stalls
// double-counts the interval (synthetic silence *and* the late real samples both land on
// the muxer timeline), which is what progressively pushed audio past video in long
// recordings. Below this threshold we emit nothing and let the muxer's gap/overlap
// reconciliation be the single owner of timeline length; only a sustained outage gets
// keepalive silence so a genuinely dead device doesn't freeze the audio track.
const STALL_SILENCE_KEEPALIVE_AFTER: Duration = Duration::from_secs(1);

fn should_fabricate_stall_silence(stall_duration: Duration, keepalive_after: Duration) -> bool {
    stall_duration >= keepalive_after
}

struct ReconnectAttemptGuard(Arc<AtomicBool>);

impl Drop for ReconnectAttemptGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

async fn complete_reconnect_attempt<T>(
    in_flight: Arc<AtomicBool>,
    cancel: CancellationToken,
    work: impl Future<Output = T>,
) -> Option<T> {
    let _attempt = ReconnectAttemptGuard(in_flight);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        result = work => Some(result),
    }
}

fn reconnect_is_due(stall: Duration, backoff: Duration, in_flight: bool) -> bool {
    !in_flight && stall >= backoff
}

fn reset_reconnect_after_frame(
    in_flight: &AtomicBool,
    attempts: &mut u32,
    next_reconnect_after: &mut Duration,
) {
    in_flight.store(false, Ordering::Relaxed);
    *attempts = 0;
    *next_reconnect_after = MIC_RECONNECT_AFTER;
}

pub struct Microphone {
    #[cfg(windows)]
    capture_scope: crate::output_pipeline::PipelineBuildScope,
    #[cfg(windows)]
    subscription: Arc<microphone::RecordingSubscription>,
    #[cfg(target_os = "linux")]
    required_health: Option<RequiredMicrophoneHealth>,
    info: AudioInfo,
    _lock: Arc<MicrophoneFeedLock>,
    cancel: CancellationToken,
}

// The detached bridge tasks hold clones of the feed lock and only exit via
// this token. If the pipeline is torn down without stop() (wedged muxer,
// error paths), a live-but-orphaned lock would keep the feed in State::Locked
// forever, making RemoveInput a silent no-op and pinning the cpal stream for
// the rest of the process.
impl Drop for Microphone {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(error) = self.subscription.retire() {
            self.capture_scope.fail_required(error);
        }
        self.cancel.cancel();
    }
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
        let source_info = AudioInfo::new_raw(ffmpeg_fmt, source_rate, source_channels);

        // `resample` feeds frames built by `wrap_frame_with_max_channels`, which tag
        // them with `ChannelLayout::default`. swr revalidates each frame's layout
        // against the context and silently drops it on a mismatch, so the context must
        // be configured with the identical layout. Using the named `channel_layout()`
        // here instead diverges for 3/4/5/6-channel sources and silenced those mics.
        let source_layout =
            source_info.wrapped_frame_layout(AudioInfo::MAX_AUDIO_CHANNELS as usize);

        let context = ffmpeg::software::resampler(
            (
                source_info.sample_format,
                source_layout,
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
        let source_info = AudioInfo::new_raw(ffmpeg_fmt, source_rate, source_channels);

        let input_frame =
            source_info.wrap_frame_with_max_channels(data, AudioInfo::MAX_AUDIO_CHANNELS as usize);
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

        // Timestamp the output with the input frame's capture time, NOT capture minus
        // the swr delay. The muxer builds the audio timeline from capture timestamps +
        // sample counts and reconciles overlaps; subtracting the resampler's (pre-run)
        // delay pulls each frame back so consecutive frames overlap, and the muxer then
        // drops a full frame each tick — e.g. a 32k→48k mic lost ~0.8s up front and
        // ran badly out of sync. Sample-count continuity already keeps duration correct.
        Some(AudioFrame::new(output, timestamp))
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct RequiredMicrophoneHealth {
    source: microphone::RecordingSourceHealth,
    scope: crate::output_pipeline::PipelineBuildScope,
}

#[cfg(target_os = "linux")]
impl RequiredMicrophoneHealth {
    fn check_terminal(&self) -> bool {
        if let Some(error) = self.source.terminal_error() {
            self.scope.fail_required(error);
            true
        } else {
            false
        }
    }

    fn accepts_frame(&self, id: u32) -> bool {
        let current = self.source.frame_is_current(id);
        if !current {
            self.check_terminal();
        }
        current
    }

    fn fail(&self, error: String) {
        self.source.fail(error);
        self.check_terminal();
    }

    fn stop(&self) {
        if let Some(error) = self.source.stop_error() {
            self.scope.fail_required(error);
        }
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
        #[cfg(windows)]
        let capture_scope = crate::output_pipeline::PipelineBuildScope::new();
        #[cfg(windows)]
        let source_cancel = ctx.stop_token().child_token();
        #[cfg(windows)]
        let subscription = feed_lock.recording_subscription(source_cancel.clone());
        #[cfg(windows)]
        {
            capture_scope.register_token(source_cancel.clone());
            let scope = capture_scope.clone();
            let cancel = source_cancel.clone();
            let subscription = subscription.clone();
            let feed = feed_lock.clone();
            ctx.tasks().spawn("microphone-owned-producers", async move {
                cancel.cancelled().await;
                finish_recording_subscription(&scope, &feed, subscription).await
            });
        }
        #[cfg(target_os = "linux")]
        let required_health = crate::output_pipeline::PipelineBuildScope::current()
            .filter(crate::output_pipeline::PipelineBuildScope::requires_source_health)
            .map(|scope| RequiredMicrophoneHealth {
                source: feed_lock.source_health(),
                scope,
            });
        #[cfg(windows)]
        let setup_scope = capture_scope.clone();
        #[cfg(windows)]
        let setup_cancel = source_cancel.clone().drop_guard();
        let setup = async move {
            let source_info = feed_lock.audio_info();
            let audio_info = source_info
                .with_max_channels(MICROPHONE_TARGET_CHANNELS)
                .with_sample_rate(AudioMixer::INFO.sample_rate)
                .with_sample_format(AudioMixer::INFO.sample_format)
                .with_channels(MICROPHONE_TARGET_CHANNELS as usize);
            let is_wireless = source_info.is_wireless_transport;
            let device_name = feed_lock.device_name().to_string();
            let reconnect_settings = microphone::MicrophoneDeviceSettings {
                sample_rate: Some(source_info.sample_rate),
                channels: u16::try_from(source_info.channels).ok(),
            };
            #[cfg(not(windows))]
            let cancel = CancellationToken::new();
            #[cfg(windows)]
            let cancel = source_cancel;
            let (tx, rx) = flume::bounded(128);

            let send_timeout = if is_wireless {
                Duration::from_millis(20)
            } else {
                Duration::from_millis(5)
            };

            #[cfg(windows)]
            feed_lock
                .attach_recording_subscription(
                    subscription.clone(),
                    tx,
                    health_tx.clone(),
                    "microphone-feed:recording".into(),
                )
                .await?;
            #[cfg(not(windows))]
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

            let recording_muted = feed_lock.recording_muted_handle();

            crate::output_pipeline::spawn_capture_task({
                let frame_counter = mic_frame_counter.clone();
                let drop_counter = mic_drop_counter.clone();
                let silence_counter = mic_silence_counter.clone();
                let feed_lock = feed_lock.clone();
                #[cfg(not(windows))]
                let device_name = device_name.clone();
                let health_tx = health_tx.clone();
                let cancel = cancel.clone();
                let recording_muted = recording_muted.clone();
                #[cfg(windows)]
                let capture_scope = capture_scope.clone();
                #[cfg(windows)]
                let subscription = subscription.clone();
                #[cfg(target_os = "linux")]
                let required_health = required_health.clone();
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
                        #[cfg(windows)]
                        if let Some(error) = subscription.error() {
                            capture_scope.fail_required(error);
                            break;
                        }
                        #[cfg(target_os = "linux")]
                        if required_health
                            .as_ref()
                            .is_some_and(RequiredMicrophoneHealth::check_terminal)
                        {
                            break;
                        }
                        let recv_result = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => break,
                            r = tokio::time::timeout(silence_timeout, rx.recv_async()) => r,
                        };
                        match recv_result {
                            Ok(Ok(frame)) => {
                                #[cfg(windows)]
                                if !subscription.accepts_frame(frame.stream_id) {
                                    continue;
                                }
                                #[cfg(target_os = "linux")]
                                if required_health
                                    .as_ref()
                                    .is_some_and(|health| !health.accepts_frame(frame.stream_id))
                                {
                                    continue;
                                }
                                if silence_mode {
                                    let stall_ms =
                                        silence_start.map(|s| s.elapsed().as_millis()).unwrap_or(0);
                                    info!(
                                        stall_ms,
                                        reconnect_attempts, "Microphone data resumed after silence"
                                    );
                                    silence_mode = false;
                                    silence_start = None;
                                    reset_reconnect_after_frame(
                                        &reconnect_in_flight,
                                        &mut reconnect_attempts,
                                        &mut next_reconnect_after,
                                    );
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

                                let Some(mut audio_frame) = audio_frame else {
                                    drop_counter.fetch_add(1, Ordering::Relaxed);
                                    continue;
                                };

                                // Mute by zeroing the payload, never by withholding the
                                // frame: cadence, sample counts, and timestamps must stay
                                // identical to the unmuted stream so the muxer timeline
                                // and the stall/keepalive machinery see no difference.
                                if recording_muted.load(Ordering::Relaxed) {
                                    silence_frame_payload(&mut audio_frame.inner);
                                }

                                let sample_count = audio_frame.samples();
                                last_frame_duration = Duration::from_secs_f64(
                                    sample_count as f64 / audio_info.rate() as f64,
                                );
                                last_timestamp = Some(frame.timestamp);

                                match tokio::time::timeout(send_timeout, audio_tx.send(audio_frame))
                                    .await
                                {
                                    Ok(Ok(())) => {
                                        #[cfg(target_os = "linux")]
                                        if sample_count > 0
                                            && let Some(health) = &required_health
                                        {
                                            health.source.accepted_frame(frame.stream_id);
                                        }
                                        frame_counter.fetch_add(1, Ordering::Relaxed);
                                    }
                                    _ => {
                                        drop_counter.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            }
                            Ok(Err(_)) => {
                                debug!("Microphone feed channel closed");
                                #[cfg(windows)]
                                if !cancel.is_cancelled() {
                                    capture_scope.fail_required(
                                        "Requested microphone feed closed before Stop".into(),
                                    );
                                }
                                #[cfg(target_os = "linux")]
                                if !cancel.is_cancelled()
                                    && let Some(health) = &required_health
                                {
                                    health.fail("Requested audio feed closed before Stop".into());
                                }
                                break;
                            }
                            Err(_) => {
                                let stall_started = *silence_start.get_or_insert_with(Instant::now);
                                let stall_duration = stall_started.elapsed();

                                if !silence_mode {
                                    warn!(
                                        is_wireless,
                                        timeout_ms = silence_timeout.as_millis(),
                                        keepalive_after_ms =
                                            STALL_SILENCE_KEEPALIVE_AFTER.as_millis(),
                                        "Microphone data timeout, awaiting delivery before keepalive silence"
                                    );
                                    silence_mode = true;
                                }

                                if reconnect_is_due(
                                    stall_duration,
                                    next_reconnect_after,
                                    reconnect_in_flight.load(Ordering::Relaxed),
                                ) {
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
                                    #[cfg(not(windows))]
                                    let name = device_name.clone();
                                    let in_flight = reconnect_in_flight.clone();
                                    let attempt_cancel = cancel.clone();
                                    #[cfg(windows)]
                                    let capture_scope = capture_scope.clone();
                                    #[cfg(windows)]
                                    let subscription = subscription.clone();
                                    #[cfg(target_os = "linux")]
                                    let required_health = required_health.clone();
                                    crate::output_pipeline::spawn_capture_task(async move {
                                        let _ = complete_reconnect_attempt(
                                            in_flight,
                                            attempt_cancel,
                                            async move {
                                                #[cfg(windows)]
                                                let reconnect = feed.reconnect_recording_subscription(subscription, reconnect_settings).await;
                                                #[cfg(not(windows))]
                                                let reconnect = feed.ask(microphone::SetInput {
                                                    label: name, settings: Some(reconnect_settings),
                                                }).await;
                                                let ready = match reconnect {
                                                    Ok(r) => r,
                                                    Err(e) => {
                                                        warn!("Microphone reconnect failed: {e}");
                                                        #[cfg(windows)]
                                                        capture_scope.fail_required(format!(
                                                            "Requested microphone reconnect failed: {e}"
                                                        ));
                                                        #[cfg(target_os = "linux")]
                                                        if let Some(health) = &required_health {
                                                            health.fail(format!("Requested audio reconnect failed: {e}"));
                                                        }
                                                        return;
                                                    }
                                                };
                                                match ready.await {
                                                    Ok(_) => {
                                                        info!("Microphone reconnect stream ready")
                                                    }
                                                    Err(e) => {
                                                        warn!("Microphone reconnect stream failed: {e}");
                                                        #[cfg(windows)]
                                                        capture_scope.fail_required(format!(
                                                            "Requested microphone reconnect stream failed: {e}"
                                                        ));
                                                    }
                                                }
                                            },
                                        )
                                        .await;
                                    });

                                    next_reconnect_after =
                                        (next_reconnect_after * 2).min(MIC_RECONNECT_BACKOFF_MAX);
                                    silence_start = Some(Instant::now());
                                }

                                if !should_fabricate_stall_silence(
                                    stall_duration,
                                    STALL_SILENCE_KEEPALIVE_AFTER,
                                ) {
                                    continue;
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

            crate::output_pipeline::spawn_capture_task({
                let cancel = cancel.clone();
                let health_tx = health_tx.clone();
                async move {
                    let frame_counter = mic_frame_counter;
                    let drop_counter = mic_drop_counter;
                    let silence_counter = mic_silence_counter;
                    let mut last_log = Instant::now();
                    let mut prev_captured: u64 = 0;
                    let mut prev_dropped: u64 = 0;
                    let mut stale_count: u32 = 0;
                    let mut high_drop_intervals: u32 = 0;
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

                            let captured_delta = captured.saturating_sub(prev_captured);
                            let dropped_delta = dropped.saturating_sub(prev_dropped);
                            let data_changed = captured != prev_captured || dropped != prev_dropped;
                            prev_captured = captured;
                            prev_dropped = dropped;

                            // Surface a *sustained* high drop rate as a health event, like
                            // every other source/muxer. The case that matters most is a
                            // resampler that rejects every frame → 100% drops → silent
                            // track, which otherwise only appears in this log line.
                            // Require two consecutive bad intervals so a single
                            // stall→resume boundary (few captures vs accumulated
                            // keepalive drops) doesn't trip a false alarm.
                            let interval_total = captured_delta + dropped_delta;
                            let interval_drop_pct = if interval_total > 0 {
                                100.0 * dropped_delta as f64 / interval_total as f64
                            } else {
                                0.0
                            };
                            if interval_total > 0 && interval_drop_pct >= 50.0 {
                                high_drop_intervals = high_drop_intervals.saturating_add(1);
                            } else {
                                high_drop_intervals = 0;
                            }
                            if high_drop_intervals >= 2 {
                                emit_health(
                                    &health_tx,
                                    PipelineHealthEvent::FrameDropRateHigh {
                                        source: "microphone".to_string(),
                                        rate_pct: interval_drop_pct,
                                    },
                                );
                            }

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

            #[cfg(windows)]
            drop(setup_cancel.disarm());
            Ok(Self {
                #[cfg(windows)]
                capture_scope,
                #[cfg(windows)]
                subscription,
                info: audio_info,
                _lock: feed_lock,
                #[cfg(target_os = "linux")]
                required_health,
                cancel,
            })
        };
        #[cfg(windows)]
        {
            async move { setup_scope.run(setup).await }
        }
        #[cfg(not(windows))]
        {
            setup
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> + Send {
        #[cfg(target_os = "linux")]
        if let Some(health) = &self.required_health {
            health.stop();
        }
        #[cfg(windows)]
        if let Some(error) = self.subscription.retire() {
            self.capture_scope.fail_required(error);
        }
        self.cancel.cancel();
        #[cfg(windows)]
        let scope = self.capture_scope.clone();
        #[cfg(windows)]
        let feed = self._lock.clone();
        #[cfg(windows)]
        let subscription = self.subscription.clone();
        async move {
            #[cfg(windows)]
            {
                finish_recording_subscription(&scope, &feed, subscription).await
            }
            #[cfg(not(windows))]
            {
                Ok(())
            }
        }
    }
}

#[cfg(windows)]
async fn finish_recording_subscription(
    scope: &crate::output_pipeline::PipelineBuildScope,
    feed: &microphone::MicrophoneFeedLock,
    subscription: Arc<microphone::RecordingSubscription>,
) -> anyhow::Result<()> {
    if let Some(error) = subscription.retire() {
        scope.fail_required(error);
    }
    let detached = feed.detach_recording_subscription(subscription).await;
    let joined = microphone_producers_join(scope).await;
    detached?;
    joined
}

#[cfg(any(windows, test))]
async fn microphone_producers_join(
    scope: &crate::output_pipeline::PipelineBuildScope,
) -> anyhow::Result<()> {
    let report = scope.cancel_and_join_report().await;
    if let Some(error) = report.error {
        anyhow::bail!(error);
    }
    anyhow::ensure!(
        report.quiescent,
        "Microphone producers did not confirm quiescence"
    );
    Ok(())
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

/// Zero a frame's sample data in place, leaving format, sample count, rate,
/// layout, and timestamp untouched. All-zero bytes are exact silence for every
/// sample format cpal/ffmpeg feed through here except U8 — and U8 device input
/// is resampled to the F32 mixer format before reaching this point, so zeroed
/// bytes are always true silence for the frames we emit.
fn silence_frame_payload(frame: &mut ffmpeg::frame::Audio) {
    for i in 0..frame.planes() {
        frame.data_mut(i).fill(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::{Sample, Type};

    #[tokio::test]
    async fn ready_success_without_frames_retries_only_after_existing_backoff() {
        let in_flight = Arc::new(AtomicBool::new(true));
        let result =
            complete_reconnect_attempt(in_flight.clone(), CancellationToken::new(), async {
                Ok::<_, ()>(())
            })
            .await;
        assert_eq!(result, Some(Ok(())));
        assert!(!in_flight.load(Ordering::Relaxed));
        let next_backoff = MIC_RECONNECT_AFTER * 2;
        assert!(!reconnect_is_due(
            Duration::from_millis(3999),
            next_backoff,
            in_flight.load(Ordering::Relaxed)
        ));
        assert!(reconnect_is_due(
            Duration::from_secs(4),
            next_backoff,
            in_flight.load(Ordering::Relaxed)
        ));
    }

    #[tokio::test]
    async fn ready_failure_releases_in_flight_without_skipping_backoff() {
        let in_flight = Arc::new(AtomicBool::new(true));
        let result =
            complete_reconnect_attempt(in_flight.clone(), CancellationToken::new(), async {
                Err::<(), _>("failed")
            })
            .await;
        assert_eq!(result, Some(Err("failed")));
        assert!(!in_flight.load(Ordering::Relaxed));
        assert!(!reconnect_is_due(
            Duration::from_secs(2),
            Duration::from_secs(4),
            false
        ));
    }

    #[test]
    fn real_frame_resets_reconnect_attempts_and_original_delay() {
        let in_flight = AtomicBool::new(true);
        let mut attempts = 3;
        let mut delay = Duration::from_secs(16);
        reset_reconnect_after_frame(&in_flight, &mut attempts, &mut delay);
        assert!(!in_flight.load(Ordering::Relaxed));
        assert_eq!(attempts, 0);
        assert_eq!(delay, MIC_RECONNECT_AFTER);
        assert!(!reconnect_is_due(Duration::from_millis(1999), delay, false));
        assert!(reconnect_is_due(Duration::from_secs(2), delay, false));
    }

    #[tokio::test]
    async fn stop_cancels_pending_reconnect_and_releases_in_flight() {
        let in_flight = Arc::new(AtomicBool::new(true));
        let cancel = CancellationToken::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let attempt = tokio::spawn(complete_reconnect_attempt(
            in_flight.clone(),
            cancel.clone(),
            async {
                started_tx.send(()).unwrap();
                std::future::pending::<()>().await;
            },
        ));
        started_rx.await.unwrap();
        cancel.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), attempt)
                .await
                .unwrap()
                .unwrap(),
            None
        );
        assert!(!in_flight.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn already_stopped_source_does_not_dispatch_reconnect() {
        let in_flight = Arc::new(AtomicBool::new(true));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result: Option<()> = complete_reconnect_attempt(in_flight.clone(), cancel, async {
            panic!("stopped source dispatched a reconnect")
        })
        .await;
        assert_eq!(result, None);
        assert!(!in_flight.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn dropped_reconnect_future_releases_in_flight() {
        let in_flight = Arc::new(AtomicBool::new(true));
        let mut attempt = Box::pin(complete_reconnect_attempt(
            in_flight.clone(),
            CancellationToken::new(),
            std::future::pending::<()>(),
        ));
        assert!(futures::poll!(attempt.as_mut()).is_pending());
        drop(attempt);
        assert!(!in_flight.load(Ordering::Relaxed));
    }

    #[test]
    fn transient_stall_does_not_fabricate_silence() {
        // The repro's worst mic stall was 293ms; none of its sub-second late-delivery
        // stalls should produce synthetic silence (the muxer reconciles them instead).
        for stall_ms in [0, 5, 54, 86, 100, 114, 200, 293, 500, 999] {
            assert!(
                !should_fabricate_stall_silence(
                    Duration::from_millis(stall_ms),
                    STALL_SILENCE_KEEPALIVE_AFTER,
                ),
                "{stall_ms}ms transient stall must not fabricate silence"
            );
        }
    }

    #[test]
    fn sustained_stall_fabricates_keepalive_silence() {
        for stall_ms in [1000, 1500, 2000, 5000] {
            assert!(
                should_fabricate_stall_silence(
                    Duration::from_millis(stall_ms),
                    STALL_SILENCE_KEEPALIVE_AFTER,
                ),
                "{stall_ms}ms sustained outage must emit keepalive silence"
            );
        }
    }

    #[test]
    fn keepalive_threshold_exceeds_reconnect_free_window() {
        // Keepalive must engage before the first reconnect attempt so a frozen device
        // never leaves the audio track without forward progress.
        assert!(STALL_SILENCE_KEEPALIVE_AFTER < MIC_RECONNECT_AFTER);
    }

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
        assert!(MicResampler::create(48000, 16, SampleFormat::F32, &target).is_some());
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
        use cap_timestamp::Timestamp;
        use std::time::Instant;

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(32000, 2, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 1024;
        const FRAME_COUNT: usize = 64;
        const CHANNELS: usize = 2;

        let ts = Timestamp::Instant(Instant::now());

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
        use cap_timestamp::Timestamp;
        use std::time::Instant;

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(96000, 2, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 1024;
        const FRAME_COUNT: usize = 64;
        const CHANNELS: usize = 2;

        let ts = Timestamp::Instant(Instant::now());
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

    #[test]
    fn resampler_accepts_more_than_eight_input_channels() {
        use cap_timestamp::Timestamp;
        use std::time::Instant;

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(48000, 16, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 960;
        const CHANNELS: usize = 16;

        let payload_len_bytes = FRAME_SAMPLES * CHANNELS * std::mem::size_of::<f32>();
        let payload = vec![0u8; payload_len_bytes];
        let frame = resampler
            .resample(
                &payload,
                48000,
                CHANNELS as u16,
                SampleFormat::F32,
                Timestamp::Instant(Instant::now()),
            )
            .expect("frame");

        assert_eq!(frame.rate(), 48000);
        assert_eq!(frame.channels(), 1);
        assert_eq!(frame.samples(), FRAME_SAMPLES);
    }

    #[test]
    fn resampler_downmixes_surround_channel_counts_without_dropping() {
        use cap_timestamp::Timestamp;
        use std::time::Instant;

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        const FRAME_SAMPLES: usize = 480;

        // 3/4/5/6 are exactly the channel counts where `ChannelLayout::default` and the
        // named `channel_layout()` masks diverge. Before the layout fix, swr rejected
        // every frame for these counts and the mic track was silent.
        for channels in [3u16, 4, 5, 6] {
            let mut resampler = MicResampler::create(48000, channels, SampleFormat::F32, &target)
                .unwrap_or_else(|| panic!("resampler for {channels}ch"));

            // Distinct non-zero signal per channel so a correct downmix carries energy
            // (a silent/dropped result is distinguishable from a real mixdown).
            let mut payload = Vec::with_capacity(FRAME_SAMPLES * channels as usize * 4);
            for _ in 0..FRAME_SAMPLES {
                for ch in 0..channels {
                    let value = 0.25f32 + 0.05 * ch as f32;
                    payload.extend_from_slice(&value.to_le_bytes());
                }
            }

            let frame = resampler
                .resample(
                    &payload,
                    48000,
                    channels,
                    SampleFormat::F32,
                    Timestamp::Instant(Instant::now()),
                )
                .unwrap_or_else(|| panic!("{channels}ch frame must not be dropped"));

            assert_eq!(frame.channels(), 1, "{channels}ch downmix should be mono");
            assert_eq!(frame.samples(), FRAME_SAMPLES, "{channels}ch sample count");

            let any_energy = frame
                .data(0)
                .chunks_exact(4)
                .take(frame.samples())
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .any(|s| s.abs() > 0.01);
            assert!(any_energy, "{channels}ch downmix produced silence");
        }
    }

    #[test]
    fn muted_frames_keep_geometry_but_zero_payload() {
        use cap_timestamp::Timestamp;
        use std::time::Instant;

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(44100, 2, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 1024;
        const CHANNELS: usize = 2;
        let mut payload = Vec::with_capacity(FRAME_SAMPLES * CHANNELS * 4);
        for i in 0..(FRAME_SAMPLES * CHANNELS) {
            let value = 0.5f32 * ((i % 7) as f32 - 3.0);
            payload.extend_from_slice(&value.to_le_bytes());
        }

        let ts_instant = Instant::now();
        let ts = Timestamp::Instant(ts_instant);
        let mut frame = None;
        for _ in 0..4 {
            if let Some(f) = resampler.resample(&payload, 44100, 2, SampleFormat::F32, ts) {
                frame = Some(f);
            }
        }
        let mut frame = frame.expect("resampler produced a frame");

        let samples_before = frame.samples();
        let rate_before = frame.rate();
        assert!(samples_before > 0);

        let had_energy = frame
            .inner
            .data(0)
            .chunks_exact(4)
            .take(samples_before)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .any(|s| s.abs() > 0.001);
        assert!(had_energy, "test signal should be non-silent before muting");

        silence_frame_payload(&mut frame.inner);

        // Muting must be a pure payload transformation: geometry, rate, and
        // timestamp identical, every sample exactly zero.
        assert_eq!(frame.samples(), samples_before);
        assert_eq!(frame.rate(), rate_before);
        match frame.timestamp {
            Timestamp::Instant(i) => assert_eq!(i, ts_instant),
            other => panic!("unexpected timestamp variant {other:?}"),
        }
        let all_zero = frame
            .inner
            .data(0)
            .chunks_exact(4)
            .take(frame.samples())
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .all(|s| s == 0.0);
        assert!(all_zero, "muted frame must be exact digital silence");
    }

    #[test]
    fn resampled_frame_timestamps_are_monotonic_and_unshifted() {
        // Regression: timestamping resampled frames with `capture − swr_delay` pulled
        // them backward, so consecutive frames overlapped and the muxer dropped ~0.8s of
        // a 32k→48k mic up front → badly out of sync. Output frames must carry the input
        // capture timestamp unchanged so the muxer timeline stays monotonic.
        use cap_timestamp::Timestamp;
        use std::time::{Duration, Instant};

        let target = AudioInfo::new_raw(Sample::F32(Type::Packed), 48000, 1);
        let mut resampler =
            MicResampler::create(32000, 2, SampleFormat::F32, &target).expect("resampler");

        const FRAME_SAMPLES: usize = 1120; // ~35ms at 32k
        const CHANNELS: usize = 2;
        let payload = vec![0u8; FRAME_SAMPLES * CHANNELS * std::mem::size_of::<f32>()];

        let base = Instant::now();
        let frame_dur = Duration::from_micros(FRAME_SAMPLES as u64 * 1_000_000 / 32_000);

        let mut prev: Option<Instant> = None;
        for n in 0..16u32 {
            let input_instant = base + frame_dur * n;
            let Some(frame) = resampler.resample(
                &payload,
                32000,
                CHANNELS as u16,
                SampleFormat::F32,
                Timestamp::Instant(input_instant),
            ) else {
                continue;
            };

            let out_instant = match frame.timestamp {
                Timestamp::Instant(i) => i,
                other => panic!("expected Instant timestamp, got {other:?}"),
            };

            // No offset: output carries the exact input capture time.
            assert_eq!(
                out_instant, input_instant,
                "frame {n} timestamp was shifted"
            );
            if let Some(p) = prev {
                assert!(out_instant >= p, "frame {n} timestamp went backwards");
            }
            prev = Some(out_instant);
        }

        assert!(prev.is_some(), "resampler produced no frames");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod required_source_outcome_tests {
    use super::*;
    use crate::output_pipeline::PipelineBuildScope;

    #[tokio::test]
    async fn continuing_failed_callbacks_cancel_before_receive_timeout_and_join_owned_work() {
        let scope = PipelineBuildScope::new_studio_lifetime();
        let cancel = CancellationToken::new();
        scope.register_token(cancel.clone());
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(7),
            scope: scope.clone(),
        };
        let (sender, receiver) = flume::bounded(128);
        for _ in 0..128 {
            sender.try_send(7).unwrap();
        }
        health.source.test_backend_failure();
        assert!(!health.check_terminal());
        let completion = scope.task_completion();
        let (release, released) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(async move {
            let _completion = completion;
            released.await.unwrap();
        });
        assert!(!health.accepts_frame(receiver.try_recv().unwrap()));
        assert_eq!(receiver.len(), 127);
        assert!(cancel.is_cancelled());
        health.stop();
        let joined = tokio::spawn(async move { scope.cancel_and_join_report().await });
        tokio::task::yield_now().await;
        assert!(!joined.is_finished());
        release.send(()).unwrap();
        writer.await.unwrap();
        let report = joined.await.unwrap();
        assert!(report.quiescent);
        assert!(
            report
                .error
                .unwrap()
                .contains("failed while continuing to deliver samples")
        );
    }

    #[tokio::test]
    async fn healthy_and_stale_callbacks_preserve_successful_required_source_stop() {
        let scope = PipelineBuildScope::new_studio_lifetime();
        let cancel = CancellationToken::new();
        scope.register_token(cancel.clone());
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(7),
            scope: scope.clone(),
        };
        for _ in 0..128 {
            assert!(health.accepts_frame(7));
            assert!(!health.accepts_frame(6));
        }
        assert!(!health.check_terminal());
        assert!(!cancel.is_cancelled());
        health.stop();
        let report = scope.cancel_and_join_report().await;
        assert!(report.quiescent);
        assert!(report.error.is_none());
    }

    #[tokio::test]
    async fn continued_backend_error_in_committed_resume_cancels_parent_attempt() {
        let parent = PipelineBuildScope::new_studio_lifetime();
        let child = parent.child_transaction();
        let cancel = CancellationToken::new();
        child.register_token(cancel.clone());
        assert!(child.commit());
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(8),
            scope: child,
        };
        health.source.test_backend_failure();
        assert!(!health.accepts_frame(8));
        assert!(cancel.is_cancelled());
        health.stop();
        let report = parent.cancel_and_join_report().await;
        assert!(report.quiescent);
        assert!(
            report
                .error
                .unwrap()
                .contains("failed while continuing to deliver samples")
        );
    }

    #[tokio::test]
    async fn confirmed_audio_failure_cancels_siblings_but_waits_for_owned_writer() {
        let scope = PipelineBuildScope::new_studio_lifetime();
        let cancel = CancellationToken::new();
        scope.register_token(cancel.clone());
        let completion = scope.task_completion();
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(0),
            scope: scope.clone(),
        };
        let (release, released) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(async move {
            let _completion = completion;
            released.await.unwrap();
        });
        health.fail("DeviceNotFound after confirmed Pulse loss".into());
        assert!(cancel.is_cancelled());
        health.stop();
        let joined = tokio::spawn(async move { scope.cancel_and_join_report().await });
        tokio::task::yield_now().await;
        assert!(!joined.is_finished());
        release.send(()).unwrap();
        writer.await.unwrap();
        let report = joined.await.unwrap();
        assert!(report.quiescent);
        assert!(report.error.unwrap().contains("DeviceNotFound"));
    }

    #[tokio::test]
    async fn feed_eof_cannot_be_a_successful_required_source_stop() {
        let scope = PipelineBuildScope::new_studio_lifetime();
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(7),
            scope: scope.clone(),
        };
        health.fail("Requested audio feed closed before Stop".into());
        health.stop();
        let report = scope.cancel_and_join_report().await;
        assert!(report.quiescent);
        assert!(report.error.unwrap().contains("closed before Stop"));
    }

    #[tokio::test]
    async fn healthy_required_source_stop_does_not_invent_failure() {
        let scope = PipelineBuildScope::new_studio_lifetime();
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(7),
            scope: scope.clone(),
        };
        assert!(!health.check_terminal());
        health.stop();
        let report = scope.cancel_and_join_report().await;
        assert!(report.quiescent);
        assert!(report.error.is_none());
        assert!(!PipelineBuildScope::new_lifetime().requires_source_health());
    }

    #[tokio::test]
    async fn committed_resume_audio_failure_still_cancels_parent_attempt() {
        let parent = PipelineBuildScope::new_studio_lifetime();
        let child = parent.child_transaction();
        assert!(child.requires_source_health());
        let cancel = CancellationToken::new();
        child.register_token(cancel.clone());
        assert!(child.commit());
        let health = RequiredMicrophoneHealth {
            source: microphone::RecordingSourceHealth::test_healthy(8),
            scope: child,
        };
        health.fail("current replacement failed".into());
        assert!(cancel.is_cancelled());
        let report = parent.cancel_and_join_report().await;
        assert!(report.quiescent);
        assert!(report.error.is_some());
    }
}

#[cfg(test)]
mod owned_microphone_tests {
    use super::*;
    use crate::output_pipeline::{PipelineBuildScope, spawn_capture_task};

    #[tokio::test]
    async fn microphone_stop_waits_for_nested_producer_acknowledgement() {
        let scope = PipelineBuildScope::new();
        let cancel = CancellationToken::new();
        scope.register_token(cancel.clone());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        scope
            .run(async move {
                drop(spawn_capture_task(async move {
                    drop(spawn_capture_task(async move {
                        let _ = ready_tx.send(());
                        cancel.cancelled().await;
                        release_rx.await.unwrap();
                    }));
                }));
            })
            .await;
        ready_rx.await.unwrap();
        let stop = tokio::spawn(async move { microphone_producers_join(&scope).await });
        tokio::task::yield_now().await;
        assert!(!stop.is_finished());
        release_tx.send(()).unwrap();
        stop.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn microphone_producer_panic_is_not_successful_stop() {
        let scope = PipelineBuildScope::new();
        let mut task = None;
        scope
            .run(async {
                task = Some(spawn_capture_task(async {
                    panic!("synthetic microphone producer panic")
                }));
            })
            .await;
        assert!(task.unwrap().await.is_err());
        assert!(microphone_producers_join(&scope).await.is_err());
    }

    #[tokio::test]
    async fn microphone_terminal_error_is_sticky_after_producers_exit() {
        let scope = PipelineBuildScope::new();
        scope.fail_required("Requested microphone reconnect failed: DeviceNotFound".into());
        assert!(microphone_producers_join(&scope).await.is_err());
        assert!(microphone_producers_join(&scope).await.is_err());
    }

    #[tokio::test]
    async fn unpolled_microphone_setup_drop_cancels_registered_completion() {
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        let setup = async move { drop(guard.disarm()) };
        drop(setup);
        assert!(cancel.is_cancelled());
    }
}
