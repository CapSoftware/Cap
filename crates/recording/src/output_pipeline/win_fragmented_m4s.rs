use crate::{
    AudioFrame, AudioMuxer, Muxer, SharedPauseState, TaskPool, VideoMuxer,
    output_pipeline::{NativeCameraFrame, camera_frame_to_ffmpeg},
    screen_capture,
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
use cap_enc_ffmpeg::segmented_stream::{
    DiskSpaceCallback, SegmentedVideoEncoder, SegmentedVideoEncoderConfig,
};
use cap_media_info::{AudioInfo, VideoInfo};
use scap_ffmpeg::AsFFmpeg;
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
        .unwrap_or(3)
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
                        "Windows M4S muxer frame drop rate exceeds 5% threshold"
                    );
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "Windows M4S muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}

struct EncoderState {
    video_tx: SyncSender<Option<(scap_direct3d::Frame, Duration)>>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct WindowsFragmentedM4SMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
}

pub struct WindowsFragmentedM4SMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
}

impl Default for WindowsFragmentedM4SMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            preset: H264Preset::Ultrafast,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
        }
    }
}

impl Muxer for WindowsFragmentedM4SMuxer {
    type Config = WindowsFragmentedM4SMuxerConfig;

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
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(),
            started: false,
            disk_space_callback: config.disk_space_callback,
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Windows M4S encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Windows M4S encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!(
                                    "Windows M4S encoder thread panicked during finish: {:?}",
                                    panic_payload
                                );
                            }
                            Ok(Err(e)) => {
                                warn!("Windows M4S encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "Windows M4S encoder thread did not finish within {:?}, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            match state.encoder.lock() {
                Ok(mut encoder) => {
                    if let Err(e) = encoder.finish_with_timestamp(timestamp) {
                        warn!("Failed to finish segmented encoder: {e}");
                    }
                }
                Err(_) => {
                    warn!("Encoder mutex poisoned during finish");
                }
            }
        }

        Ok(Ok(()))
    }
}

impl WindowsFragmentedM4SMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Windows M4S muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(scap_direct3d::Frame, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: self.output_size,
        };

        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(callback) = &self.disk_space_callback {
            encoder.set_disk_space_callback(callback.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("win-m4s-segment-encoder".to_string())
            .spawn(move || {
                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                }

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((d3d_frame, timestamp))) = video_rx.recv() {
                    let convert_start = std::time::Instant::now();

                    let ffmpeg_frame_result = d3d_frame.as_ffmpeg();
                    let convert_elapsed_ms = convert_start.elapsed().as_millis();

                    if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                        slow_convert_count += 1;
                        if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = convert_elapsed_ms,
                                count = slow_convert_count,
                                "D3D11 frame conversion exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match ffmpeg_frame_result {
                        Ok(ffmpeg_frame) => {
                            let encode_start = std::time::Instant::now();

                            match encoder_clone.lock() {
                                Ok(mut encoder) => {
                                    if let Err(e) = encoder.queue_frame(ffmpeg_frame, timestamp) {
                                        warn!("Failed to encode frame: {e}");
                                    }
                                }
                                Err(_) => {
                                    warn!("Encoder mutex poisoned, skipping frame");
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
                            warn!("Failed to convert D3D11 frame to FFmpeg: {e:?}");
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
                        "Windows M4S encoder timing summary (using SegmentedVideoEncoder)"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Windows M4S encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started Windows M4S fragmented video encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for WindowsFragmentedM4SMuxer {
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
                .try_send(Some((frame.frame, adjusted_timestamp)))
            {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(e) => match e {
                    std::sync::mpsc::TrySendError::Full(_) => {
                        self.frame_drops.record_drop();
                    }
                    std::sync::mpsc::TrySendError::Disconnected(_) => {
                        trace!("Windows M4S encoder channel disconnected");
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsFragmentedM4SMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}

struct CameraEncoderState {
    video_tx: SyncSender<Option<(NativeCameraFrame, Duration)>>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct WindowsFragmentedM4SCameraMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    state: Option<CameraEncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
}

pub struct WindowsFragmentedM4SCameraMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
}

impl Default for WindowsFragmentedM4SCameraMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            preset: H264Preset::Ultrafast,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
        }
    }
}

impl Muxer for WindowsFragmentedM4SCameraMuxer {
    type Config = WindowsFragmentedM4SCameraMuxerConfig;

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
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(),
            started: false,
            disk_space_callback: config.disk_space_callback,
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Windows M4S camera encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Windows M4S camera encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!(
                                    "Windows M4S camera encoder thread panicked during finish: {:?}",
                                    panic_payload
                                );
                            }
                            Ok(Err(e)) => {
                                warn!("Windows M4S camera encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "Windows M4S camera encoder thread did not finish within {:?}, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            match state.encoder.lock() {
                Ok(mut encoder) => {
                    if let Err(e) = encoder.finish_with_timestamp(timestamp) {
                        warn!("Failed to finish camera segmented encoder: {e}");
                    }
                }
                Err(_) => {
                    warn!("Camera encoder mutex poisoned during finish");
                }
            }
        }

        Ok(Ok(()))
    }
}

impl WindowsFragmentedM4SCameraMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Windows M4S camera muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(NativeCameraFrame, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: self.output_size,
        };

        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(callback) = &self.disk_space_callback {
            encoder.set_disk_space_callback(callback.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("win-m4s-camera-segment-encoder".to_string())
            .spawn(move || {
                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!(
                        "Failed to send ready signal - camera receiver dropped"
                    ));
                }

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((camera_frame, timestamp))) = video_rx.recv() {
                    let convert_start = std::time::Instant::now();
                    let ffmpeg_frame_result = camera_frame_to_ffmpeg(&camera_frame);
                    let convert_elapsed_ms = convert_start.elapsed().as_millis();

                    if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                        slow_convert_count += 1;
                        if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = convert_elapsed_ms,
                                count = slow_convert_count,
                                "Camera frame conversion exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match ffmpeg_frame_result {
                        Ok(ffmpeg_frame) => {
                            let encode_start = std::time::Instant::now();

                            match encoder_clone.lock() {
                                Ok(mut encoder) => {
                                    if let Err(e) = encoder.queue_frame(ffmpeg_frame, timestamp) {
                                        warn!("Failed to encode camera frame: {e}");
                                    }
                                }
                                Err(_) => {
                                    warn!("Camera encoder mutex poisoned, skipping frame");
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
                        "Windows M4S camera encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Windows M4S camera encoder thread ended unexpectedly"))??;

        self.state = Some(CameraEncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started Windows M4S fragmented camera encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for WindowsFragmentedM4SCameraMuxer {
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
            match state.video_tx.try_send(Some((frame, adjusted_timestamp))) {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(e) => match e {
                    std::sync::mpsc::TrySendError::Full(_) => {
                        self.frame_drops.record_drop();
                    }
                    std::sync::mpsc::TrySendError::Disconnected(_) => {
                        trace!("Windows M4S camera encoder channel disconnected");
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsFragmentedM4SCameraMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}
