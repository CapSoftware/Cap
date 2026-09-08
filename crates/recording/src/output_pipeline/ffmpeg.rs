use crate::{
    SharedPauseState, TaskPool,
    output_pipeline::{
        AudioFrame, AudioMuxer, Muxer, STALL_BUDGET_MS, VideoFrame, VideoMuxer,
        frame_timing_log_threshold_ms,
    },
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::{
    aac::AACEncoder,
    dash_audio::{DashAudioSegmentEncoder, DashAudioSegmentEncoderConfig},
    fragmented_audio::{FinishError as FragmentedAudioFinishError, FragmentedAudioFile},
    h264::*,
    ogg::*,
    opus::OpusEncoder,
    segmented_audio::SegmentedAudioEncoder,
    segmented_stream::{SegmentCompletedEvent, SegmentedVideoEncoder, SegmentedVideoEncoderConfig},
};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::Timestamp;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool, mpsc::sync_channel},
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;

#[derive(Clone)]
pub struct FFmpegVideoFrame {
    pub inner: ffmpeg::frame::Video,
    pub timestamp: Timestamp,
}

impl VideoFrame for FFmpegVideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }

    fn duplicate(&self) -> Option<Self> {
        let mut inner = ffmpeg::frame::Video::empty();
        let status = unsafe { ffmpeg::ffi::av_frame_ref(inner.as_mut_ptr(), self.inner.as_ptr()) };
        (status >= 0).then_some(Self {
            inner,
            timestamp: self.timestamp,
        })
    }
}

pub struct Mp4Muxer {
    output: ffmpeg::format::context::Output,
    video_encoder: Option<H264Encoder>,
    audio_encoder: Option<AACEncoder>,
}

impl Muxer for Mp4Muxer {
    type Config = ();

    async fn setup(
        _: Self::Config,
        output_path: std::path::PathBuf,
        video_config: Option<cap_media_info::VideoInfo>,
        audio_config: Option<cap_media_info::AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let mut output = ffmpeg::format::output(&output_path)?;

        let video_encoder = video_config
            .map(|video_config| H264Encoder::builder(video_config).build(&mut output))
            .transpose()
            .context("video encoder")?;

        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()
            .context("audio encoder")?;

        output.write_header()?;

        Ok(Self {
            output,
            video_encoder,
            audio_encoder,
        })
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        let video_result = self
            .video_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        self.output.write_trailer().context("write_trailer")?;

        if video_result.is_ok() && audio_result.is_ok() {
            return Ok(Ok(()));
        }

        Ok(Err(anyhow!(
            "Video: {video_result:#?}, Audio: {audio_result:#?}"
        )))
    }
}

impl VideoMuxer for Mp4Muxer {
    type VideoFrame = FFmpegVideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        if let Some(video_encoder) = self.video_encoder.as_mut() {
            video_encoder.queue_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}

impl AudioMuxer for Mp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(audio_encoder) = self.audio_encoder.as_mut() {
            audio_encoder.send_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}

pub struct OggMuxer(OggFile);

impl Muxer for OggMuxer {
    type Config = ();

    async fn setup(
        _: Self::Config,
        output_path: PathBuf,
        _: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let audio_config =
            audio_config.ok_or_else(|| anyhow!("No audio configuration provided"))?;

        Ok(Self(
            OggFile::init(output_path, |o| OpusEncoder::init(audio_config, o))
                .map_err(|e| anyhow!("Failed to initialize Opus encoder: {e}"))?,
        ))
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.0
            .finish()
            .map_err(Into::into)
            .map(|r| r.map_err(Into::into))
    }
}

impl AudioMuxer for OggMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        Ok(self.0.queue_frame(frame.inner, timestamp)?)
    }
}

pub struct FragmentedAudioMuxer {
    encoder: FragmentedAudioFile,
    pause: Option<SharedPauseState>,
}

#[derive(Default)]
pub struct FragmentedAudioMuxerConfig {
    pub shared_pause_state: Option<SharedPauseState>,
}

impl Muxer for FragmentedAudioMuxer {
    type Config = FragmentedAudioMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        _: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let audio_config =
            audio_config.ok_or_else(|| anyhow!("No audio configuration provided"))?;

        Ok(Self {
            encoder: FragmentedAudioFile::init(output_path, audio_config)
                .map_err(|e| anyhow!("Failed to initialize fragmented audio encoder: {e}"))?,
            pause: config.shared_pause_state,
        })
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        match self.encoder.finish_with_timestamp(timestamp) {
            Ok(result) => Ok(result.map_err(Into::into)),
            Err(FragmentedAudioFinishError::AlreadyFinished) => Ok(Ok(())),
            Err(FragmentedAudioFinishError::WriteTrailerFailed(error)) => Ok(Err(anyhow!(error))),
        }
    }
}

impl AudioMuxer for FragmentedAudioMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        let adjusted_timestamp = if let Some(pause) = &self.pause {
            match pause.adjust(timestamp)? {
                Some(ts) => ts,
                None => return Ok(()),
            }
        } else {
            timestamp
        };

        Ok(self.encoder.queue_frame(frame.inner, adjusted_timestamp)?)
    }
}

pub struct SegmentedAudioMuxer {
    encoder: SegmentedAudioEncoder,
    pause: Option<SharedPauseState>,
}

pub struct SegmentedAudioMuxerConfig {
    pub segment_duration: Duration,
    pub shared_pause_state: Option<SharedPauseState>,
}

impl Default for SegmentedAudioMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            shared_pause_state: None,
        }
    }
}

impl Muxer for SegmentedAudioMuxer {
    type Config = SegmentedAudioMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        _: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let audio_config =
            audio_config.ok_or_else(|| anyhow!("No audio configuration provided"))?;

        Ok(Self {
            encoder: SegmentedAudioEncoder::init(
                output_path,
                audio_config,
                config.segment_duration,
            )
            .map_err(|e| anyhow!("Failed to initialize segmented audio encoder: {e}"))?,
            pause: config.shared_pause_state,
        })
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.encoder
            .finish_with_timestamp(timestamp)
            .map_err(Into::into)
            .map(|_| Ok(()))
    }
}

impl AudioMuxer for SegmentedAudioMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        let adjusted_timestamp = if let Some(pause) = &self.pause {
            match pause.adjust(timestamp)? {
                Some(ts) => ts,
                None => return Ok(()),
            }
        } else {
            timestamp
        };

        self.encoder
            .queue_frame(frame.inner, adjusted_timestamp)
            .map_err(|e| anyhow!("Failed to queue audio frame: {e}"))
    }
}

fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30)
}

struct FrameDropTracker {
    drops_in_window: u32,
    frames_in_window: u32,
    total_drops: u64,
    total_frames: u64,
    last_check: std::time::Instant,
}

impl FrameDropTracker {
    fn new() -> Self {
        Self {
            drops_in_window: 0,
            frames_in_window: 0,
            total_drops: 0,
            total_frames: 0,
            last_check: std::time::Instant::now(),
        }
    }

    fn record_frame(&mut self) {
        self.frames_in_window += 1;
        self.total_frames += 1;
        self.check_drop_rate();
    }

    fn record_drop(&mut self) {
        self.drops_in_window += 1;
        self.total_drops += 1;
        self.check_drop_rate();
    }

    fn check_drop_rate(&mut self) {
        if self.last_check.elapsed() >= Duration::from_secs(5) {
            let total_in_window = self.frames_in_window + self.drops_in_window;
            if total_in_window > 0 {
                let drop_rate = 100.0 * self.drops_in_window as f64 / total_in_window as f64;
                if drop_rate > 5.0 {
                    warn!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        total_frames = self.total_frames,
                        total_drops = self.total_drops,
                        "Segmented muxer frame drop rate exceeds 5% threshold"
                    );
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "Segmented muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }

    fn report_final_stats(&self) {
        let total = self.total_frames + self.total_drops;
        if total == 0 {
            return;
        }

        let drop_rate = 100.0 * self.total_drops as f64 / total as f64;

        if self.total_drops > 0 {
            if drop_rate > 5.0 {
                warn!(
                    total_frames = self.total_frames,
                    total_drops = self.total_drops,
                    drop_rate_pct = format!("{:.1}%", drop_rate),
                    "Recording finished with significant frame drops"
                );
            } else {
                info!(
                    total_frames = self.total_frames,
                    total_drops = self.total_drops,
                    drop_rate_pct = format!("{:.1}%", drop_rate),
                    "Recording finished with minor frame drops"
                );
            }
        } else {
            debug!(
                total_frames = self.total_frames,
                "Recording finished with no frame drops"
            );
        }
    }
}

fn send_segmented_frame<T>(
    sender: &flume::Sender<T>,
    frame: T,
    frame_drops: &mut FrameDropTracker,
) -> anyhow::Result<()> {
    match sender.send_timeout(frame, Duration::from_millis(STALL_BUDGET_MS)) {
        Ok(()) => frame_drops.record_frame(),
        Err(flume::SendTimeoutError::Timeout(_)) => frame_drops.record_drop(),
        Err(flume::SendTimeoutError::Disconnected(_)) => {
            return Err(anyhow!("Segmented encoder channel disconnected"));
        }
    }
    Ok(())
}

struct SegmentedEncoderState {
    video_tx: flume::Sender<Option<(ffmpeg::frame::Video, Duration)>>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct SegmentedVideoMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    state: Option<SegmentedEncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    strict_finish: bool,
}

pub struct SegmentedVideoMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
}

impl Default for SegmentedVideoMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            preset: H264Preset::Ultrafast,
            output_size: None,
            shared_pause_state: None,
            segment_tx: None,
        }
    }
}

impl Muxer for SegmentedVideoMuxer {
    type Config = SegmentedVideoMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        _audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let video_config =
            video_config.ok_or_else(|| anyhow!("invariant: video config expected"))?;

        std::fs::create_dir_all(&output_path)
            .with_context(|| format!("Failed to create segments directory: {output_path:?}"))?;

        let pause = config
            .shared_pause_state
            .unwrap_or_else(|| SharedPauseState::new(pause_flag));

        Ok(Self {
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            output_size: config.output_size,
            segment_tx: config.segment_tx,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(),
            started: false,
            strict_finish: super::core::PipelineBuildScope::current()
                .is_some_and(|scope| scope.requires_joined_stop()),
        })
    }

    fn stop(&mut self) {
        if self.strict_finish {
            if let Some(state) = &self.state {
                let _ = state.video_tx.try_send(None);
            }
            return;
        }
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Segmented encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if self.strict_finish {
            return Ok(self.finish_joined(timestamp));
        }
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Segmented encoder channel already closed during finish: {e}");
            }

            let mut encoder_thread_finished = false;

            if let Some(handle) = state.encoder_handle.take() {
                let fps =
                    self.video_config.frame_rate.0 as f32 / self.video_config.frame_rate.1 as f32;
                let buffer_size = get_muxer_buffer_size();
                let base_timeout_secs = 5u64;
                let buffer_drain_time_secs = (buffer_size as f32 / fps.max(1.0)).ceil() as u64;
                let total_timeout_secs = base_timeout_secs + buffer_drain_time_secs.min(30);
                let timeout = Duration::from_secs(total_timeout_secs);

                debug!(
                    fps = fps,
                    buffer_size = buffer_size,
                    timeout_secs = total_timeout_secs,
                    "Waiting for encoder thread to finish"
                );

                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        encoder_thread_finished = true;
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!(
                                    "Segmented encoder thread panicked during finish: {:?}",
                                    panic_payload
                                );
                            }
                            Ok(Err(e)) => {
                                warn!("Segmented encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            fps = fps,
                            buffer_size = buffer_size,
                            elapsed_secs = start.elapsed().as_secs(),
                            "Segmented encoder thread did not finish within {:?}, abandoning (encoder may be overwhelmed at this resolution/fps)",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            } else {
                encoder_thread_finished = true;
            }

            if encoder_thread_finished {
                if let Ok(mut encoder) = state.encoder.lock()
                    && let Err(e) = encoder.finish_with_timestamp(timestamp)
                {
                    warn!("Failed to finish segmented encoder: {e}");
                }
            } else {
                warn!("Skipping encoder finalization because encoder thread is still running");
                if let Ok(mut encoder) = state.encoder.try_lock()
                    && let Err(e) = encoder.finish_with_timestamp(timestamp)
                {
                    warn!("Failed to finish segmented encoder (non-blocking attempt): {e}");
                }
            }
        }

        self.frame_drops.report_final_stats();

        Ok(Ok(()))
    }
}

fn join_segmented_encoder(handle: Option<JoinHandle<anyhow::Result<()>>>) -> anyhow::Result<()> {
    match handle {
        Some(handle) => handle
            .join()
            .unwrap_or_else(|_| Err(anyhow!("Segmented encoder thread panicked"))),
        None => Ok(()),
    }
}

impl SegmentedVideoMuxer {
    fn finish_joined(&mut self, timestamp: Duration) -> anyhow::Result<()> {
        let Some(mut state) = self.state.take() else {
            return Ok(());
        };
        let _ = state.video_tx.send(None);
        let thread_error = join_segmented_encoder(state.encoder_handle.take()).err();
        let finish_error = match state.encoder.lock() {
            Ok(mut encoder) => encoder
                .finish_with_timestamp(timestamp)
                .map_err(anyhow::Error::from)
                .err(),
            Err(_) => Some(anyhow!("Segmented encoder state is poisoned")),
        };
        self.frame_drops.report_final_stats();
        match (thread_error, finish_error) {
            (None, None) => Ok(()),
            (Some(error), None) | (None, Some(error)) => Err(error),
            (Some(worker), Some(finish)) => Err(anyhow!("{worker:#}; finalization: {finish:#}")),
        }
    }

    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Segmented muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            flume::bounded::<Option<(ffmpeg::frame::Video, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: self.output_size,
            prefer_videotoolbox_hw_input: false,
        };

        let slow_threshold_ms = frame_timing_log_threshold_ms(&self.video_config);
        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(tx) = &self.segment_tx {
            encoder.set_segment_callback(tx.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let strict_scope =
            super::core::PipelineBuildScope::current().filter(|scope| scope.requires_joined_stop());
        let build_completion =
            super::core::PipelineBuildScope::current().map(|scope| scope.task_completion());
        let encoder_handle = std::thread::Builder::new()
            .name("segmented-video-encoder".to_string())
            .spawn(move || {
                let _build_completion = build_completion;
                (move || {
                    if ready_tx.send(Ok(())).is_err() {
                        return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                    }

                    let mut slow_encode_count = 0u32;
                    let mut encode_error_count = 0u32;
                    let mut total_frames = 0u64;

                    while let Ok(Some((frame, timestamp))) = video_rx.recv() {
                        let encode_start = std::time::Instant::now();

                        if let Ok(mut encoder) = encoder_clone.lock()
                            && let Err(e) = encoder.queue_frame(frame, timestamp)
                        {
                            if let Some(scope) = &strict_scope {
                                scope
                                    .fail_required(format!("Segmented video encoding failed: {e}"));
                                return Err(anyhow!("Segmented video encoding failed: {e}"));
                            }
                            encode_error_count += 1;
                            if encode_error_count <= 3 {
                                warn!("Failed to encode frame: {e}");
                            } else if encode_error_count == 4 {
                                warn!("Suppressing further encode errors (too many failures)");
                            }
                        }

                        let encode_elapsed_ms = encode_start.elapsed().as_millis();

                        if encode_elapsed_ms > slow_threshold_ms {
                            slow_encode_count += 1;
                            if slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                debug!(
                                    elapsed_ms = encode_elapsed_ms,
                                    count = slow_encode_count,
                                    "encoder.queue_frame exceeded {}ms threshold",
                                    slow_threshold_ms
                                );
                            }
                        }

                        total_frames += 1;
                    }

                    if total_frames > 0 {
                        debug!(
                            total_frames = total_frames,
                            slow_encodes = slow_encode_count,
                            encode_errors = encode_error_count,
                            slow_encode_pct = format!(
                                "{:.1}%",
                                100.0 * slow_encode_count as f64 / total_frames as f64
                            ),
                            "Segmented encoder timing summary"
                        );
                    }

                    if encode_error_count > 0 {
                        warn!(
                            encode_errors = encode_error_count,
                            total_frames = total_frames,
                            "Encoder finished with {} encode errors out of {} frames",
                            encode_error_count,
                            total_frames
                        );
                    }

                    Ok(())
                })()
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Segmented encoder thread ended unexpectedly"))??;

        self.state = Some(SegmentedEncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started segmented video encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for SegmentedVideoMuxer {
    type VideoFrame = FFmpegVideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let Some(adjusted_timestamp) = self.pause.adjust(timestamp)? else {
            return Ok(());
        };

        if !self.started {
            self.start_encoder()?;
        }

        if let Some(state) = &self.state {
            send_segmented_frame(
                &state.video_tx,
                Some((frame.inner, adjusted_timestamp)),
                &mut self.frame_drops,
            )?;
        }

        Ok(())
    }
}

impl AudioMuxer for SegmentedVideoMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}

pub struct DashSegmentedAudioMuxer {
    encoder: DashAudioSegmentEncoder,
    pause: Option<SharedPauseState>,
}

pub struct DashSegmentedAudioMuxerConfig {
    pub segment_duration: Duration,
    pub shared_pause_state: Option<SharedPauseState>,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
}

impl Default for DashSegmentedAudioMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            shared_pause_state: None,
            segment_tx: None,
        }
    }
}

impl Muxer for DashSegmentedAudioMuxer {
    type Config = DashSegmentedAudioMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        _: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let audio_config =
            audio_config.ok_or_else(|| anyhow!("No audio configuration provided"))?;

        let mut encoder = DashAudioSegmentEncoder::init(
            output_path,
            audio_config,
            DashAudioSegmentEncoderConfig {
                segment_duration: config.segment_duration,
            },
        )
        .map_err(|e| anyhow!("Failed to initialize DASH audio segment encoder: {e}"))?;

        if let Some(tx) = config.segment_tx {
            encoder.set_segment_callback(tx);
        }

        Ok(Self {
            encoder,
            pause: config.shared_pause_state,
        })
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.encoder
            .finish_with_timestamp(timestamp)
            .map_err(Into::into)
            .map(|_| Ok(()))
    }
}

impl AudioMuxer for DashSegmentedAudioMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        let adjusted_timestamp = if let Some(pause) = &self.pause {
            match pause.adjust(timestamp)? {
                Some(ts) => ts,
                None => return Ok(()),
            }
        } else {
            timestamp
        };

        self.encoder
            .queue_frame(frame.inner, adjusted_timestamp)
            .map_err(|e| anyhow!("Failed to queue audio frame: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{FFmpegVideoFrame, FrameDropTracker, VideoFrame, send_segmented_frame};
    use cap_timestamp::Timestamp;
    use std::time::Instant;

    #[test]
    fn segmented_encoder_preserves_frames_when_a_full_queue_recovers() {
        let (sender, receiver) = flume::bounded(1);
        sender.send(1).unwrap();
        let consumer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            assert_eq!(receiver.recv().unwrap(), 1);
            receiver.recv_timeout(std::time::Duration::from_millis(200))
        });
        let mut drops = FrameDropTracker::new();

        send_segmented_frame(&sender, 2, &mut drops).unwrap();

        assert_eq!(consumer.join().unwrap().unwrap(), 2);
        assert_eq!(drops.total_frames, 1);
        assert_eq!(drops.total_drops, 0);
    }

    #[test]
    fn segmented_encoder_bounds_waiting_for_a_stalled_queue() {
        let (sender, _receiver) = flume::bounded(1);
        sender.send(1).unwrap();
        let mut drops = FrameDropTracker::new();
        let started = std::time::Instant::now();

        send_segmented_frame(&sender, 2, &mut drops).unwrap();

        assert!(started.elapsed() >= std::time::Duration::from_millis(50));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(drops.total_frames, 0);
        assert_eq!(drops.total_drops, 1);
    }

    #[test]
    fn segmented_encoder_reports_disconnected_queue() {
        let (sender, receiver) = flume::bounded(1);
        drop(receiver);
        let mut drops = FrameDropTracker::new();

        assert!(send_segmented_frame(&sender, 2, &mut drops).is_err());
        assert_eq!(drops.total_frames, 0);
        assert_eq!(drops.total_drops, 0);
    }

    #[test]
    fn duplicated_video_frame_reuses_reference_counted_pixel_storage() {
        let timestamp = Instant::now();
        let mut inner = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 16, 12);
        inner.set_pts(Some(417));
        inner.data_mut(0)[..4].copy_from_slice(&[11, 22, 33, 44]);
        let original = FFmpegVideoFrame {
            inner,
            timestamp: Timestamp::Instant(timestamp),
        };

        let duplicate = original.duplicate().expect("reference-counted video frame");

        assert_eq!(
            duplicate.inner.data(0).as_ptr(),
            original.inner.data(0).as_ptr()
        );
        assert_eq!(duplicate.inner.format(), original.inner.format());
        assert_eq!(duplicate.inner.width(), original.inner.width());
        assert_eq!(duplicate.inner.height(), original.inner.height());
        assert_eq!(duplicate.inner.pts(), Some(417));
        assert!(matches!(duplicate.timestamp, Timestamp::Instant(value) if value == timestamp));
        let buffer = unsafe { (*original.inner.as_ptr()).buf[0] };
        assert!(!buffer.is_null());
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(buffer) }, 2);

        drop(original);

        assert_eq!(&duplicate.inner.data(0)[..4], &[11, 22, 33, 44]);
        let retained = unsafe { (*duplicate.inner.as_ptr()).buf[0] };
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(retained) }, 1);
    }
    #[tokio::test]
    async fn strict_encoder_join_waits_for_actual_thread_without_blocking_runtime() {
        let (release, blocked) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            blocked.recv().unwrap();
            Err(anyhow::anyhow!("encoder queue failed"))
        });
        let mut joining =
            tokio::task::spawn_blocking(move || super::join_segmented_encoder(Some(thread)));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut joining)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert!(
            joining
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("encoder queue failed")
        );
    }

    #[test]
    fn strict_encoder_join_retains_thread_panic() {
        let thread = std::thread::spawn(|| -> anyhow::Result<()> { panic!("encoder fault") });
        assert!(
            super::join_segmented_encoder(Some(thread))
                .unwrap_err()
                .to_string()
                .contains("panicked")
        );
    }
}
