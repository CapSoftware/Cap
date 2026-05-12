use super::core::{
    BlockingThreadFinish, DiskSpaceMonitor, HealthSender, PipelineHealthEvent, SharedHealthSender,
    combine_finish_errors, wait_for_blocking_thread_finish,
};
use super::macos_frame_convert::{FramePool, fill_frame_from_sample_buf};
use crate::{
    AudioFrame, AudioMuxer, Muxer, SharedPauseState, TaskPool, VideoMuxer,
    output_pipeline::NativeCameraFrame, screen_capture,
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
use cap_enc_ffmpeg::segmented_stream::{
    DiskSpaceCallback, SegmentCompletedEvent, SegmentedVideoEncoder, SegmentedVideoEncoderConfig,
};
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::AtomicBool,
        mpsc::{SyncSender, sync_channel},
    },
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;

fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60)
}

struct FrameDropTracker {
    drops_in_window: u32,
    frames_in_window: u32,
    total_drops: u64,
    total_frames: u64,
    last_check: std::time::Instant,
    health_tx: SharedHealthSender,
    source: &'static str,
}

impl FrameDropTracker {
    fn new(health_tx: SharedHealthSender, source: &'static str) -> Self {
        Self {
            drops_in_window: 0,
            frames_in_window: 0,
            total_drops: 0,
            total_frames: 0,
            last_check: std::time::Instant::now(),
            health_tx,
            source,
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
                        "M4S muxer frame drop rate exceeds 5% threshold"
                    );
                    self.health_tx.emit(PipelineHealthEvent::FrameDropRateHigh {
                        source: self.source.to_string(),
                        rate_pct: drop_rate,
                    });
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "M4S muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}

fn finish_encoder_thread(
    handle: JoinHandle<anyhow::Result<()>>,
    label: &str,
) -> BlockingThreadFinish {
    wait_for_blocking_thread_finish(handle, Duration::from_secs(5), label)
}

fn finish_segmented_encoder(
    mut state: EncoderState,
    timestamp: Duration,
    thread_label: &str,
    finish_label: &str,
) -> anyhow::Result<()> {
    if let Err(error) = state.video_tx.send(None) {
        trace!("{thread_label} channel already closed during finish: {error}");
    }

    let thread_result = state
        .encoder_handle
        .take()
        .map(|handle| finish_encoder_thread(handle, thread_label))
        .unwrap_or(BlockingThreadFinish::Clean);

    let thread_error = match thread_result {
        BlockingThreadFinish::Clean => None,
        BlockingThreadFinish::Failed(error) => Some(error),
        BlockingThreadFinish::TimedOut(error) => return Err(error),
    };

    let finalize_error = match state.encoder.lock() {
        Ok(mut encoder) => encoder
            .finish_with_timestamp(timestamp)
            .map_err(|error| anyhow!("{finish_label}: {error:#}"))
            .err(),
        Err(_) => Some(anyhow!(
            "{finish_label}: encoder mutex poisoned - recording may be corrupt or incomplete"
        )),
    };

    match (thread_error, finalize_error) {
        (None, None) => Ok(()),
        (Some(error), None) | (None, Some(error)) => Err(error),
        (Some(primary), Some(secondary)) => Err(combine_finish_errors(primary, secondary)),
    }
}

struct EncoderState {
    video_tx: SyncSender<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct MacOSFragmentedM4SMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    bpp: f32,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    health_tx: SharedHealthSender,
}

pub struct MacOSFragmentedM4SMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
}

impl Default for MacOSFragmentedM4SMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(2),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
            segment_tx: None,
        }
    }
}

impl Muxer for MacOSFragmentedM4SMuxer {
    type Config = MacOSFragmentedM4SMuxerConfig;

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
            bpp: config.bpp,
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(SharedHealthSender::new(), "muxer:macos-fragmented"),
            started: false,
            disk_space_callback: config.disk_space_callback,
            segment_tx: config.segment_tx,
            health_tx: SharedHealthSender::new(),
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state {
            if state.video_tx.try_send(None).is_ok() {
                return;
            }
            for _ in 0..5 {
                std::thread::sleep(Duration::from_millis(50));
                match state.video_tx.try_send(None) {
                    Ok(()) => return,
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                        trace!("M4S encoder channel closed during stop retry");
                        return;
                    }
                    Err(std::sync::mpsc::TrySendError::Full(_)) => {}
                }
            }
            warn!("M4S encoder channel still full after retries, finish() will deliver sentinel");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(state) = self.state.take()
            && let Err(error) = finish_segmented_encoder(
                state,
                timestamp,
                "M4S encoder",
                "Failed to finish segmented encoder",
            )
        {
            return Ok(Err(error));
        }

        Ok(Ok(()))
    }

    fn set_health_sender(&mut self, tx: HealthSender) {
        self.health_tx.set(tx);
        self.frame_drops.health_tx = self.health_tx.clone();
    }
}

impl MacOSFragmentedM4SMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "M4S muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: self.bpp,
            output_size: self.output_size,
        };

        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(callback) = &self.disk_space_callback {
            encoder.set_disk_space_callback(callback.clone());
        }
        if let Some(tx) = &self.segment_tx {
            encoder.set_segment_callback(tx.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();
        let video_config = self.video_config;
        let health_tx = self.health_tx.clone();
        let base_path = self.base_path.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("m4s-segment-encoder".to_string())
            .spawn(move || {
                let pixel_format = match video_config.pixel_format {
                    cap_media_info::Pixel::NV12 => ffmpeg::format::Pixel::NV12,
                    cap_media_info::Pixel::BGRA => ffmpeg::format::Pixel::BGRA,
                    cap_media_info::Pixel::UYVY422 => ffmpeg::format::Pixel::UYVY422,
                    _ => ffmpeg::format::Pixel::NV12,
                };

                let mut frame_pool =
                    FramePool::new(pixel_format, video_config.width, video_config.height);

                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                }

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                let mut disk_monitor = DiskSpaceMonitor::new();
                let mut disk_exhausted = false;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((sample_buf, timestamp))) = video_rx.recv() {
                    if matches!(
                        disk_monitor.poll(&base_path, &health_tx),
                        super::core::DiskSpacePollResult::Exhausted { .. }
                            | super::core::DiskSpacePollResult::Stopped
                    ) {
                        disk_exhausted = true;
                    }
                    if disk_exhausted {
                        continue;
                    }
                    let convert_start = std::time::Instant::now();
                    let frame = frame_pool.get_frame();
                    let fill_result = fill_frame_from_sample_buf(&sample_buf, frame);
                    let convert_elapsed_ms = convert_start.elapsed().as_millis();

                    if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                        slow_convert_count += 1;
                        if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = convert_elapsed_ms,
                                count = slow_convert_count,
                                "fill_frame_from_sample_buf exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match fill_result {
                        Ok(()) => {
                            let encode_start = std::time::Instant::now();
                            let owned_frame = frame_pool.take_frame();

                            match encoder_clone.lock() {
                                Ok(mut encoder) => {
                                    if let Err(e) = encoder.queue_frame(owned_frame, timestamp) {
                                        warn!("Failed to encode frame: {e}");
                                    }
                                }
                                Err(_) => {
                                    error!("Encoder mutex poisoned - encoder thread likely panicked, stopping");
                                    return Err(anyhow!("Encoder mutex poisoned - all subsequent frames would be lost"));
                                }
                            }

                            let encode_elapsed_ms = encode_start.elapsed().as_millis();

                            if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                                slow_encode_count += 1;
                                if slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                    debug!(
                                        elapsed_ms = encode_elapsed_ms,
                                        count = slow_encode_count,
                                        "encoder.queue_frame exceeded {}ms threshold",
                                        SLOW_THRESHOLD_MS
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Failed to convert frame: {e:?}");
                        }
                    }

                    total_frames += 1;
                }

                if total_frames > 0 {
                    debug!(
                        total_frames = total_frames,
                        slow_converts = slow_convert_count,
                        slow_encodes = slow_encode_count,
                        slow_convert_pct = format!(
                            "{:.1}%",
                            100.0 * slow_convert_count as f64 / total_frames as f64
                        ),
                        slow_encode_pct = format!(
                            "{:.1}%",
                            100.0 * slow_encode_count as f64 / total_frames as f64
                        ),
                        "M4S encoder timing summary (using SegmentedVideoEncoder)"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("M4S encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started M4S fragmented video encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for MacOSFragmentedM4SMuxer {
    type VideoFrame = screen_capture::VideoFrame;

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
            match state
                .video_tx
                .try_send(Some((frame.sample_buf, adjusted_timestamp)))
            {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(e) => match e {
                    std::sync::mpsc::TrySendError::Full(_) => {
                        self.frame_drops.record_drop();
                    }
                    std::sync::mpsc::TrySendError::Disconnected(_) => {
                        return Err(anyhow!("M4S encoder channel disconnected"));
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for MacOSFragmentedM4SMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}

pub struct MacOSFragmentedM4SCameraMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    bpp: f32,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    health_tx: SharedHealthSender,
}

pub struct MacOSFragmentedM4SCameraMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
}

impl Default for MacOSFragmentedM4SCameraMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(2),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
            segment_tx: None,
        }
    }
}

impl Muxer for MacOSFragmentedM4SCameraMuxer {
    type Config = MacOSFragmentedM4SCameraMuxerConfig;

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
            video_config.ok_or_else(|| anyhow!("invariant: video config expected for camera"))?;

        std::fs::create_dir_all(&output_path).with_context(|| {
            format!("Failed to create camera segments directory: {output_path:?}")
        })?;

        let pause = config
            .shared_pause_state
            .unwrap_or_else(|| SharedPauseState::new(pause_flag));

        Ok(Self {
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            bpp: config.bpp,
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(
                SharedHealthSender::new(),
                "muxer:macos-fragmented-camera",
            ),
            started: false,
            disk_space_callback: config.disk_space_callback,
            segment_tx: config.segment_tx,
            health_tx: SharedHealthSender::new(),
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state {
            if state.video_tx.try_send(None).is_ok() {
                return;
            }
            for _ in 0..5 {
                std::thread::sleep(Duration::from_millis(50));
                match state.video_tx.try_send(None) {
                    Ok(()) => return,
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                        trace!("M4S camera encoder channel closed during stop retry");
                        return;
                    }
                    Err(std::sync::mpsc::TrySendError::Full(_)) => {}
                }
            }
            warn!(
                "M4S camera encoder channel still full after retries, finish() will deliver sentinel"
            );
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(state) = self.state.take()
            && let Err(error) = finish_segmented_encoder(
                state,
                timestamp,
                "M4S camera encoder",
                "Failed to finish camera segmented encoder",
            )
        {
            return Ok(Err(error));
        }

        Ok(Ok(()))
    }

    fn set_health_sender(&mut self, tx: HealthSender) {
        self.health_tx.set(tx);
        self.frame_drops.health_tx = self.health_tx.clone();
    }
}

impl MacOSFragmentedM4SCameraMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "M4S camera muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: self.bpp,
            output_size: self.output_size,
        };

        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(callback) = &self.disk_space_callback {
            encoder.set_disk_space_callback(callback.clone());
        }
        if let Some(tx) = &self.segment_tx {
            encoder.set_segment_callback(tx.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();
        let video_config = self.video_config;
        let health_tx = self.health_tx.clone();
        let base_path = self.base_path.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("m4s-camera-segment-encoder".to_string())
            .spawn(move || {
                let pixel_format = match video_config.pixel_format {
                    cap_media_info::Pixel::NV12 => ffmpeg::format::Pixel::NV12,
                    cap_media_info::Pixel::BGRA => ffmpeg::format::Pixel::BGRA,
                    cap_media_info::Pixel::UYVY422 => ffmpeg::format::Pixel::UYVY422,
                    _ => ffmpeg::format::Pixel::NV12,
                };

                let mut frame_pool =
                    FramePool::new(pixel_format, video_config.width, video_config.height);

                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!(
                        "Failed to send ready signal - camera receiver dropped"
                    ));
                }

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                let mut disk_monitor = DiskSpaceMonitor::new();
                let mut disk_exhausted = false;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((sample_buf, timestamp))) = video_rx.recv() {
                    if matches!(
                        disk_monitor.poll(&base_path, &health_tx),
                        super::core::DiskSpacePollResult::Exhausted { .. }
                            | super::core::DiskSpacePollResult::Stopped
                    ) {
                        disk_exhausted = true;
                    }
                    if disk_exhausted {
                        continue;
                    }

                    let convert_start = std::time::Instant::now();
                    let frame = frame_pool.get_frame();
                    let fill_result = fill_frame_from_sample_buf(&sample_buf, frame);
                    let convert_elapsed_ms = convert_start.elapsed().as_millis();

                    if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                        slow_convert_count += 1;
                        if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = convert_elapsed_ms,
                                count = slow_convert_count,
                                "Camera fill_frame_from_sample_buf exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match fill_result {
                        Ok(()) => {
                            let encode_start = std::time::Instant::now();
                            let owned_frame = frame_pool.take_frame();

                            match encoder_clone.lock() {
                                Ok(mut encoder) => {
                                    if let Err(e) = encoder.queue_frame(owned_frame, timestamp) {
                                        warn!("Failed to encode camera frame: {e}");
                                    }
                                }
                                Err(_) => {
                                    error!("Camera encoder mutex poisoned - encoder thread likely panicked, stopping");
                                    return Err(anyhow!("Camera encoder mutex poisoned - all subsequent frames would be lost"));
                                }
                            }

                            let encode_elapsed_ms = encode_start.elapsed().as_millis();

                            if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                                slow_encode_count += 1;
                                if slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                    debug!(
                                        elapsed_ms = encode_elapsed_ms,
                                        count = slow_encode_count,
                                        "Camera encoder.queue_frame exceeded {}ms threshold",
                                        SLOW_THRESHOLD_MS
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Failed to convert camera frame: {e:?}");
                        }
                    }

                    total_frames += 1;
                }

                if total_frames > 0 {
                    debug!(
                        total_frames = total_frames,
                        slow_converts = slow_convert_count,
                        slow_encodes = slow_encode_count,
                        slow_convert_pct = format!(
                            "{:.1}%",
                            100.0 * slow_convert_count as f64 / total_frames as f64
                        ),
                        slow_encode_pct = format!(
                            "{:.1}%",
                            100.0 * slow_encode_count as f64 / total_frames as f64
                        ),
                        "M4S camera encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("M4S camera encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started M4S fragmented camera encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for MacOSFragmentedM4SCameraMuxer {
    type VideoFrame = NativeCameraFrame;

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
            match state
                .video_tx
                .try_send(Some((frame.sample_buf, adjusted_timestamp)))
            {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(e) => match e {
                    std::sync::mpsc::TrySendError::Full(_) => {
                        self.frame_drops.record_drop();
                    }
                    std::sync::mpsc::TrySendError::Disconnected(_) => {
                        return Err(anyhow!("M4S camera encoder channel disconnected"));
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for MacOSFragmentedM4SCameraMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}
