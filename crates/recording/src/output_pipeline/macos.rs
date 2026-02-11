use crate::{
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoFrame, VideoMuxer},
    sources::screen_capture,
};
use anyhow::anyhow;
use cap_enc_avfoundation::QueueFrameError;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::Timestamp;
use cidre::arc;
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

const DEFAULT_MP4_MUXER_BUFFER_SIZE: usize = 60;
const DEFAULT_MP4_MUXER_BUFFER_SIZE_INSTANT: usize = 240;

const DISK_SPACE_MIN_START_MB: u64 = 500;
const DISK_SPACE_CRITICAL_MB: u64 = 200;
const DISK_SPACE_CHECK_INTERVAL: Duration = Duration::from_secs(10);

fn get_available_disk_space_mb(path: &std::path::Path) -> Option<u64> {
    use std::ffi::CString;
    let c_path = CString::new(path.parent().unwrap_or(path).to_str()?).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if result != 0 {
        return None;
    }
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64) / (1024 * 1024))
}

fn get_mp4_muxer_buffer_size(instant_mode: bool) -> usize {
    std::env::var("CAP_MP4_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(if instant_mode {
            DEFAULT_MP4_MUXER_BUFFER_SIZE_INSTANT
        } else {
            DEFAULT_MP4_MUXER_BUFFER_SIZE
        })
}

type SharedFatalError = Arc<Mutex<Option<String>>>;

fn set_fatal_error(fatal_error: &SharedFatalError, message: String) {
    if let Ok(mut slot) = fatal_error.lock() {
        if slot.is_none() {
            error!("{message}");
            *slot = Some(message);
        }
    } else {
        error!("Failed to record fatal encoder error");
    }
}

fn fatal_error_message(fatal_error: &SharedFatalError) -> Option<String> {
    fatal_error
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().cloned())
}

fn wait_for_worker(
    handle: JoinHandle<anyhow::Result<()>>,
    timeout: Duration,
    worker_name: &str,
) -> anyhow::Result<()> {
    let start = std::time::Instant::now();
    loop {
        if handle.is_finished() {
            return match handle.join() {
                Ok(res) => res,
                Err(panic_payload) => Err(anyhow!("{worker_name} panicked: {panic_payload:?}")),
            };
        }

        if start.elapsed() > timeout {
            return Err(anyhow!("{worker_name} did not finish within {:?}", timeout));
        }

        std::thread::sleep(Duration::from_millis(50));
    }
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
                        "MP4 muxer frame drop rate exceeds 5% threshold"
                    );
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "MP4 muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}

#[derive(Clone)]
pub struct NativeCameraFrame {
    pub sample_buf: arc::R<cidre::cm::SampleBuf>,
    pub timestamp: Timestamp,
}

unsafe impl Send for NativeCameraFrame {}
unsafe impl Sync for NativeCameraFrame {}

impl VideoFrame for NativeCameraFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

enum VideoFrameMessage {
    Frame(arc::R<cidre::cm::SampleBuf>, Duration),
    Pause,
    Resume,
}

enum AudioFrameMessage {
    Frame(ffmpeg::frame::Audio, Duration),
}

struct Mp4EncoderState {
    video_tx: SyncSender<Option<VideoFrameMessage>>,
    audio_tx: Option<SyncSender<Option<AudioFrameMessage>>>,
    encoder: Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
    audio_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct AVFoundationMp4Muxer {
    state: Option<Mp4EncoderState>,
    pause_flag: Arc<AtomicBool>,
    frame_drops: FrameDropTracker,
    was_paused: bool,
}

#[derive(Default)]
pub struct AVFoundationMp4MuxerConfig {
    pub output_height: Option<u32>,
    pub instant_mode: bool,
}

impl Muxer for AVFoundationMp4Muxer {
    type Config = AVFoundationMp4MuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self> {
        let video_config =
            video_config.ok_or_else(|| anyhow!("Invariant: No video source provided"))?;

        let buffer_size = get_mp4_muxer_buffer_size(config.instant_mode);
        debug!(
            buffer_size,
            instant_mode = config.instant_mode,
            "MP4 muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) = sync_channel::<Option<VideoFrameMessage>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder = if config.instant_mode {
            cap_enc_avfoundation::MP4Encoder::init_instant_mode(
                output_path.clone(),
                video_config,
                audio_config,
                config.output_height,
            )
        } else {
            cap_enc_avfoundation::MP4Encoder::init(
                output_path.clone(),
                video_config,
                audio_config,
                config.output_height,
            )
        }
        .map_err(|e| anyhow!("{e}"))?;

        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("mp4-video-encoder".to_string())
            .spawn(move || {
                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                }

                let mut total_frames = 0u64;
                let mut encoder_busy_count = 0u64;

                while let Ok(Some(msg)) = video_rx.recv() {
                    match msg {
                        VideoFrameMessage::Frame(sample_buf, timestamp) => {
                            let mut encoder = match encoder_clone.lock() {
                                Ok(e) => e,
                                Err(_) => {
                                    error!("MP4 encoder mutex poisoned");
                                    return Err(anyhow!("MP4 encoder mutex poisoned"));
                                }
                            };

                            let mut retry_count = 0;
                            const MAX_RETRIES: u32 = 100;

                            loop {
                                match encoder.queue_video_frame(sample_buf.clone(), timestamp) {
                                    Ok(()) => break,
                                    Err(QueueFrameError::NotReadyForMore) => {
                                        retry_count += 1;
                                        if retry_count >= MAX_RETRIES {
                                            encoder_busy_count += 1;
                                            if encoder_busy_count <= 5 || encoder_busy_count.is_multiple_of(100) {
                                                debug!(
                                                    encoder_busy_count,
                                                    "MP4 encoder busy, frame queued after max retries"
                                                );
                                            }
                                            break;
                                        }
                                        std::thread::sleep(Duration::from_micros(500));
                                    }
                                    Err(e) => {
                                        warn!("Failed to encode video frame: {e}");
                                        break;
                                    }
                                }
                            }

                            total_frames += 1;
                        }
                        VideoFrameMessage::Pause => {
                            if let Ok(mut encoder) = encoder_clone.lock() {
                                encoder.pause();
                            }
                        }
                        VideoFrameMessage::Resume => {
                            if let Ok(mut encoder) = encoder_clone.lock() {
                                encoder.resume();
                            }
                        }
                    }
                }

                if total_frames > 0 {
                    debug!(
                        total_frames,
                        encoder_busy_count,
                        busy_pct = format!("{:.1}%", 100.0 * encoder_busy_count as f64 / total_frames as f64),
                        "MP4 video encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("MP4 encoder thread ended unexpectedly"))??;

        let (audio_tx, audio_handle) = if audio_config.is_some() {
            let (audio_tx, audio_rx) = sync_channel::<Option<AudioFrameMessage>>(buffer_size);
            let encoder_clone = encoder.clone();
            let (audio_ready_tx, audio_ready_rx) = sync_channel::<anyhow::Result<()>>(1);

            let audio_handle = std::thread::Builder::new()
                .name("mp4-audio-encoder".to_string())
                .spawn(move || {
                    if audio_ready_tx.send(Ok(())).is_err() {
                        return Err(anyhow!("Failed to send audio ready signal"));
                    }

                    let mut total_frames = 0u64;
                    let mut encoder_busy_count = 0u64;

                    while let Ok(Some(msg)) = audio_rx.recv() {
                        match msg {
                            AudioFrameMessage::Frame(frame, timestamp) => {
                                let mut encoder = match encoder_clone.lock() {
                                    Ok(e) => e,
                                    Err(_) => {
                                        error!("MP4 audio encoder mutex poisoned");
                                        return Err(anyhow!("MP4 audio encoder mutex poisoned"));
                                    }
                                };

                                let mut retry_count = 0;
                                const MAX_RETRIES: u32 = 50;

                                loop {
                                    match encoder.queue_audio_frame(&frame, timestamp) {
                                        Ok(()) => break,
                                        Err(QueueFrameError::NotReadyForMore) => {
                                            retry_count += 1;
                                            if retry_count >= MAX_RETRIES {
                                                encoder_busy_count += 1;
                                                break;
                                            }
                                            std::thread::sleep(Duration::from_micros(500));
                                        }
                                        Err(e) => {
                                            warn!("Failed to encode audio frame: {e}");
                                            break;
                                        }
                                    }
                                }

                                total_frames += 1;
                            }
                        }
                    }

                    if total_frames > 0 {
                        debug!(
                            total_frames,
                            encoder_busy_count, "MP4 audio encoder summary"
                        );
                    }

                    Ok(())
                })?;

            audio_ready_rx
                .recv()
                .map_err(|_| anyhow!("MP4 audio encoder thread ended unexpectedly"))??;

            (Some(audio_tx), Some(audio_handle))
        } else {
            (None, None)
        };

        info!(
            path = %output_path.display(),
            "Started non-blocking MP4 encoder"
        );

        Ok(Self {
            state: Some(Mp4EncoderState {
                video_tx,
                audio_tx,
                encoder,
                encoder_handle: Some(encoder_handle),
                audio_handle,
            }),
            pause_flag,
            frame_drops: FrameDropTracker::new(),
            was_paused: false,
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state {
            if let Err(e) = state.video_tx.send(None) {
                trace!("MP4 encoder video channel already closed during stop: {e}");
            }
            if let Some(audio_tx) = &state.audio_tx
                && let Err(e) = audio_tx.send(None)
            {
                trace!("MP4 encoder audio channel already closed during stop: {e}");
            }
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("MP4 encoder video channel already closed during finish: {e}");
            }
            if let Some(audio_tx) = &state.audio_tx
                && let Err(e) = audio_tx.send(None)
            {
                trace!("MP4 encoder audio channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!("MP4 encoder thread panicked: {:?}", panic_payload);
                            }
                            Ok(Err(e)) => {
                                warn!("MP4 encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!("MP4 encoder thread did not finish within {:?}", timeout);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            if let Some(handle) = state.audio_handle.take() {
                let timeout = Duration::from_secs(2);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        let _ = handle.join();
                        break;
                    }
                    if start.elapsed() > timeout {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            match state.encoder.lock() {
                Ok(mut encoder) => {
                    if let Err(e) = encoder.finish(Some(timestamp)) {
                        warn!("Failed to finish MP4 encoder: {e}");
                    }
                }
                Err(_) => {
                    error!("MP4 encoder mutex poisoned during finish");
                    return Ok(Err(anyhow!("MP4 encoder mutex poisoned")));
                }
            }
        }

        Ok(Ok(()))
    }
}

impl VideoMuxer for AVFoundationMp4Muxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let is_paused = self.pause_flag.load(std::sync::atomic::Ordering::Relaxed);

        if let Some(state) = &self.state {
            if is_paused && !self.was_paused {
                let _ = state.video_tx.try_send(Some(VideoFrameMessage::Pause));
                self.was_paused = true;
                return Ok(());
            } else if !is_paused && self.was_paused {
                let _ = state.video_tx.try_send(Some(VideoFrameMessage::Resume));
                self.was_paused = false;
            }

            if is_paused {
                return Ok(());
            }

            match state
                .video_tx
                .try_send(Some(VideoFrameMessage::Frame(frame.sample_buf, timestamp)))
            {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    self.frame_drops.record_drop();
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    trace!("MP4 encoder video channel disconnected");
                }
            }
        }

        Ok(())
    }
}

impl AudioMuxer for AVFoundationMp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(state) = &self.state
            && let Some(audio_tx) = &state.audio_tx
        {
            let owned_frame = {
                let mut new_frame = ffmpeg::frame::Audio::new(
                    frame.inner.format(),
                    frame.inner.samples(),
                    frame.inner.channel_layout(),
                );
                new_frame.clone_from(&frame.inner);
                new_frame
            };

            match audio_tx.try_send(Some(AudioFrameMessage::Frame(owned_frame, timestamp))) {
                Ok(()) => {}
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    trace!("MP4 audio encoder buffer full, dropping frame");
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    trace!("MP4 audio encoder channel disconnected");
                }
            }
        }

        Ok(())
    }
}

enum CameraFrameMessage {
    Frame(arc::R<cidre::cm::SampleBuf>, Duration),
    Pause,
    Resume,
}

struct CameraEncoderState {
    video_tx: SyncSender<Option<CameraFrameMessage>>,
    encoder: Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct AVFoundationCameraMuxer {
    state: Option<CameraEncoderState>,
    pause_flag: Arc<AtomicBool>,
    frame_drops: FrameDropTracker,
    was_paused: bool,
}

#[derive(Default)]
pub struct AVFoundationCameraMuxerConfig {
    pub output_height: Option<u32>,
}

impl Muxer for AVFoundationCameraMuxer {
    type Config = AVFoundationCameraMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        _audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self> {
        let video_config =
            video_config.ok_or_else(|| anyhow!("Invariant: No video source provided"))?;

        let buffer_size = get_mp4_muxer_buffer_size(false);
        debug!(buffer_size, "Camera MP4 muxer encoder channel buffer size");

        let (video_tx, video_rx) = sync_channel::<Option<CameraFrameMessage>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder = cap_enc_avfoundation::MP4Encoder::init(
            output_path.clone(),
            video_config,
            None,
            config.output_height,
        )
        .map_err(|e| anyhow!("{e}"))?;

        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("mp4-camera-encoder".to_string())
            .spawn(move || {
                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                }

                let mut total_frames = 0u64;
                let mut encoder_busy_count = 0u64;

                while let Ok(Some(msg)) = video_rx.recv() {
                    match msg {
                        CameraFrameMessage::Frame(sample_buf, timestamp) => {
                            let mut encoder = match encoder_clone.lock() {
                                Ok(e) => e,
                                Err(_) => {
                                    error!("Camera MP4 encoder mutex poisoned");
                                    return Err(anyhow!("Camera MP4 encoder mutex poisoned"));
                                }
                            };

                            let mut retry_count = 0;
                            const MAX_RETRIES: u32 = 100;

                            loop {
                                match encoder.queue_video_frame(sample_buf.clone(), timestamp) {
                                    Ok(()) => break,
                                    Err(QueueFrameError::NotReadyForMore) => {
                                        retry_count += 1;
                                        if retry_count >= MAX_RETRIES {
                                            encoder_busy_count += 1;
                                            if encoder_busy_count <= 5 || encoder_busy_count.is_multiple_of(100) {
                                                debug!(
                                                    encoder_busy_count,
                                                    "Camera MP4 encoder busy, frame queued after max retries"
                                                );
                                            }
                                            break;
                                        }
                                        std::thread::sleep(Duration::from_micros(500));
                                    }
                                    Err(e) => {
                                        warn!("Failed to encode camera frame: {e}");
                                        break;
                                    }
                                }
                            }

                            total_frames += 1;
                        }
                        CameraFrameMessage::Pause => {
                            if let Ok(mut encoder) = encoder_clone.lock() {
                                encoder.pause();
                            }
                        }
                        CameraFrameMessage::Resume => {
                            if let Ok(mut encoder) = encoder_clone.lock() {
                                encoder.resume();
                            }
                        }
                    }
                }

                if total_frames > 0 {
                    debug!(
                        total_frames,
                        encoder_busy_count,
                        busy_pct = format!("{:.1}%", 100.0 * encoder_busy_count as f64 / total_frames as f64),
                        "Camera MP4 encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Camera MP4 encoder thread ended unexpectedly"))??;

        info!(
            path = %output_path.display(),
            "Started non-blocking camera MP4 encoder"
        );

        Ok(Self {
            state: Some(CameraEncoderState {
                video_tx,
                encoder,
                encoder_handle: Some(encoder_handle),
            }),
            pause_flag,
            frame_drops: FrameDropTracker::new(),
            was_paused: false,
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Camera MP4 encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Camera MP4 encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!("Camera MP4 encoder thread panicked: {:?}", panic_payload);
                            }
                            Ok(Err(e)) => {
                                warn!("Camera MP4 encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "Camera MP4 encoder thread did not finish within {:?}",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            match state.encoder.lock() {
                Ok(mut encoder) => {
                    if let Err(e) = encoder.finish(Some(timestamp)) {
                        warn!("Failed to finish camera MP4 encoder: {e}");
                    }
                }
                Err(_) => {
                    error!("Camera MP4 encoder mutex poisoned during finish");
                    return Ok(Err(anyhow!("Camera MP4 encoder mutex poisoned")));
                }
            }
        }

        Ok(Ok(()))
    }
}

impl VideoMuxer for AVFoundationCameraMuxer {
    type VideoFrame = NativeCameraFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let is_paused = self.pause_flag.load(std::sync::atomic::Ordering::Relaxed);

        if let Some(state) = &self.state {
            if is_paused && !self.was_paused {
                let _ = state.video_tx.try_send(Some(CameraFrameMessage::Pause));
                self.was_paused = true;
                return Ok(());
            } else if !is_paused && self.was_paused {
                let _ = state.video_tx.try_send(Some(CameraFrameMessage::Resume));
                self.was_paused = false;
            }

            if is_paused {
                return Ok(());
            }

            match state
                .video_tx
                .try_send(Some(CameraFrameMessage::Frame(frame.sample_buf, timestamp)))
            {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    self.frame_drops.record_drop();
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    trace!("Camera MP4 encoder channel disconnected");
                }
            }
        }

        Ok(())
    }
}

impl AudioMuxer for AVFoundationCameraMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}
