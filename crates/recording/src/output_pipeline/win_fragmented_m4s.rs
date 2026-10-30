use super::core::{
    BlockingThreadFinish, DiskSpaceMonitor, HealthSender, PipelineHealthEvent, SharedHealthSender,
    combine_finish_errors, wait_for_blocking_thread_finish,
};
use super::frame_pacing::{FramePacer, Paced};
use super::mjpeg::MjpegDecoder;
use super::win::{duration_to_timespan, reference_video_frame};
use crate::{
    AudioFrame, AudioMuxer, Muxer, SharedPauseState, TaskPool, VideoMuxer,
    capture_pipeline::EncoderPreferences,
    output_pipeline::{NativeCameraFrame, camera_frame_to_ffmpeg},
    screen_capture,
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
use cap_enc_ffmpeg::segmented_stream::{
    SegmentCompletedEvent, SegmentedPacketMuxer, SegmentedVideoEncoder, SegmentedVideoEncoderConfig,
};
use cap_enc_mediafoundation::H264Encoder;
use cap_media_info::{AudioInfo, Pixel, VideoInfo};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::AtomicBool,
        mpsc::{RecvTimeoutError, SyncSender, sync_channel},
    },
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;
use windows::{
    Graphics::SizeInt32,
    Win32::Graphics::{Direct3D11::ID3D11Device, Dxgi::Common::DXGI_FORMAT},
};

const DEFAULT_MUXER_BUFFER_SIZE: usize = 240;

fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MUXER_BUFFER_SIZE)
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

    #[allow(dead_code)]
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
                    self.health_tx.emit(PipelineHealthEvent::FrameDropRateHigh {
                        source: self.source.to_string(),
                        rate_pct: drop_rate,
                    });
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

fn finish_encoder_thread(
    handle: JoinHandle<anyhow::Result<()>>,
    label: &str,
) -> BlockingThreadFinish {
    wait_for_blocking_thread_finish(handle, Duration::from_secs(5), label)
}

trait FinishableEncoderState {
    fn close_channel(&self, thread_label: &str);
    fn take_handle(&mut self) -> Option<JoinHandle<anyhow::Result<()>>>;
    fn finish_encoder(&self, timestamp: Duration, finish_label: &str) -> anyhow::Result<()>;
}

impl FinishableEncoderState for EncoderState {
    fn close_channel(&self, thread_label: &str) {
        if let Err(error) = self.video_tx.send(None) {
            trace!("{thread_label} channel already closed during finish: {error}");
        }
    }

    fn take_handle(&mut self) -> Option<JoinHandle<anyhow::Result<()>>> {
        self.encoder_handle.take()
    }

    fn finish_encoder(&self, timestamp: Duration, finish_label: &str) -> anyhow::Result<()> {
        self.backend
            .finish_with_timestamp(timestamp)
            .map_err(|error| anyhow!("{finish_label}: {error:#}"))
    }
}

impl FinishableEncoderState for CameraEncoderState {
    fn close_channel(&self, thread_label: &str) {
        if let Err(error) = self.video_tx.send(None) {
            trace!("{thread_label} channel already closed during finish: {error}");
        }
    }

    fn take_handle(&mut self) -> Option<JoinHandle<anyhow::Result<()>>> {
        self.encoder_handle.take()
    }

    fn finish_encoder(&self, timestamp: Duration, finish_label: &str) -> anyhow::Result<()> {
        match self.encoder.lock() {
            Ok(mut encoder) => encoder
                .finish_with_timestamp(timestamp)
                .map_err(|error| anyhow!("{finish_label}: {error:#}")),
            Err(_) => Err(anyhow!(
                "{finish_label}: encoder mutex poisoned - recording may be corrupt or incomplete"
            )),
        }
    }
}

fn normalize_timestamp(ts: Duration, first: &mut Option<Duration>) -> Duration {
    match *first {
        Some(first_ts) => ts.checked_sub(first_ts).unwrap_or(Duration::ZERO),
        None => {
            *first = Some(ts);
            Duration::ZERO
        }
    }
}

fn finish_segmented_encoder_impl(
    state: &mut impl FinishableEncoderState,
    timestamp: Duration,
    thread_label: &str,
    finish_label: &str,
) -> anyhow::Result<()> {
    state.close_channel(thread_label);

    let thread_result = state
        .take_handle()
        .map(|handle| finish_encoder_thread(handle, thread_label))
        .unwrap_or(BlockingThreadFinish::Clean);

    let thread_error = match thread_result {
        BlockingThreadFinish::Clean => None,
        BlockingThreadFinish::Failed(error) => Some(error),
        BlockingThreadFinish::TimedOut(error) => return Err(error),
    };

    let finalize_error = state.finish_encoder(timestamp, finish_label).err();

    match (thread_error, finalize_error) {
        (None, None) => Ok(()),
        (Some(error), None) | (None, Some(error)) => Err(error),
        (Some(primary), Some(secondary)) => Err(combine_finish_errors(primary, secondary)),
    }
}

struct EncoderState {
    video_tx: SyncSender<Option<(screen_capture::ScreenFrame, Duration)>>,
    backend: EncoderBackend,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

enum EncoderBackend {
    Ffmpeg(Arc<Mutex<SegmentedVideoEncoder>>),
    MediaFoundation(Arc<Mutex<SegmentedPacketMuxer>>),
}

impl EncoderBackend {
    fn finish_with_timestamp(&self, timestamp: Duration) -> anyhow::Result<()> {
        match self {
            Self::Ffmpeg(encoder) => match encoder.lock() {
                Ok(mut encoder) => encoder
                    .finish_with_timestamp(timestamp)
                    .map_err(|error| anyhow!("{error:#}")),
                Err(_) => Err(anyhow!(
                    "encoder mutex poisoned - recording may be corrupt or incomplete"
                )),
            },
            Self::MediaFoundation(muxer) => match muxer.lock() {
                Ok(mut muxer) => muxer.finish().map_err(|error| anyhow!("{error:#}")),
                Err(_) => Err(anyhow!(
                    "muxer mutex poisoned - recording may be corrupt or incomplete"
                )),
            },
        }
    }
}

pub struct WindowsFragmentedM4SMuxer {
    timed_fragments: bool,
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    bpp: f32,
    output_size: Option<(u32, u32)>,
    d3d_device: Option<ID3D11Device>,
    pixel_format: Option<DXGI_FORMAT>,
    encoder_preferences: EncoderPreferences,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    health_tx: SharedHealthSender,
}

pub struct WindowsFragmentedM4SMuxerConfig {
    pub timed_fragments: bool,
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub d3d_device: Option<ID3D11Device>,
    pub pixel_format: Option<DXGI_FORMAT>,
    pub encoder_preferences: EncoderPreferences,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
}

impl Default for WindowsFragmentedM4SMuxerConfig {
    fn default() -> Self {
        Self {
            timed_fragments: false,
            segment_duration: Duration::from_secs(2),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
            shared_pause_state: None,
            d3d_device: None,
            pixel_format: None,
            encoder_preferences: EncoderPreferences::new(),
            segment_tx: None,
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

        let mut muxer = Self {
            timed_fragments: config.timed_fragments,
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            bpp: config.bpp,
            output_size: config.output_size,
            d3d_device: config.d3d_device,
            pixel_format: config.pixel_format,
            encoder_preferences: config.encoder_preferences,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(
                SharedHealthSender::new(),
                "muxer:windows-fragmented",
            ),
            started: false,
            segment_tx: config.segment_tx,
            health_tx: SharedHealthSender::new(),
        };

        muxer.start_encoder()?;

        Ok(muxer)
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Windows M4S encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take()
            && let Err(error) = finish_segmented_encoder_impl(
                &mut state,
                timestamp,
                "Windows M4S encoder",
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

impl WindowsFragmentedM4SMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        if self.start_media_foundation_encoder()? {
            return Ok(());
        }

        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Windows M4S muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(screen_capture::ScreenFrame, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: self.bpp,
            output_size: self.output_size,
            prefer_videotoolbox_hw_input: false,
        };

        let mut encoder = SegmentedVideoEncoder::init_with_timed_fragments(
            self.base_path.clone(),
            self.video_config,
            encoder_config,
            self.timed_fragments,
        )?;
        if let Some(tx) = self.segment_tx.take() {
            encoder.set_segment_callback(tx);
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let video_config = self.video_config;
        let health_tx = self.health_tx.clone();
        let base_path = self.base_path.clone();
        let pause_flag = self.pause.flag();
        let encoder_handle = std::thread::Builder::new()
            .name("win-m4s-segment-encoder".to_string())
            .spawn(move || {
                cap_mediafoundation_utils::thread_init();

                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                }

                let mut pacer = FramePacer::new(video_config.fps());
                let mut last_ffmpeg_frame: Option<ffmpeg::frame::Video> = None;
                let mut first_timestamp: Option<Duration> = None;

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                let mut duplicated_frames = 0u64;
                let mut readback_frames = 0u64;
                let mut readback_misses = 0u64;
                let mut disk_monitor = DiskSpaceMonitor::new();
                let mut disk_exhausted = false;
                const SLOW_THRESHOLD_MS: u128 = 5;

                let encode_frame_fn = |ffmpeg_frame: ffmpeg::frame::Video,
                                       timestamp: Duration,
                                       slow_encode_count: &mut u32,
                                       total_frames: &mut u64,
                                       encoder: &Arc<Mutex<SegmentedVideoEncoder>>|
                 -> anyhow::Result<()> {
                    let encode_start = std::time::Instant::now();

                    match encoder.lock() {
                        Ok(mut enc) => {
                            if let Err(e) = enc.queue_frame(ffmpeg_frame, timestamp) {
                                warn!("Failed to encode frame: {e}");
                            }
                        }
                        Err(_) => {
                            return Err(anyhow!(
                                "Encoder mutex poisoned - all subsequent frames would be lost"
                            ));
                        }
                    }

                    let encode_elapsed_ms = encode_start.elapsed().as_millis();

                    if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                        *slow_encode_count += 1;
                        if *slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = encode_elapsed_ms,
                                count = *slow_encode_count,
                                "encoder.queue_frame exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    *total_frames += 1;
                    Ok(())
                };

                loop {
                    if matches!(
                        disk_monitor.poll(&base_path, &health_tx),
                        super::core::DiskSpacePollResult::Exhausted { .. }
                            | super::core::DiskSpacePollResult::Stopped
                    ) {
                        disk_exhausted = true;
                    }
                    if disk_exhausted {
                        break;
                    }

                    let (ffmpeg_frame, timestamp, readback_elapsed) =
                        match pacer.next(&video_rx, &pause_flag) {
                            Paced::Frame(frame, ts) => {
                                let readback_start = std::time::Instant::now();
                                let ffmpeg_frame = frame.as_ffmpeg();
                                let readback_elapsed = readback_start.elapsed();
                                match ffmpeg_frame {
                                    Ok(f) => {
                                        last_ffmpeg_frame = Some(reference_video_frame(&f));
                                        (Some(f), ts, Some(readback_elapsed))
                                    }
                                    Err(e) => {
                                        let readback_miss = matches!(
                                            e,
                                            scap_ffmpeg::AsFFmpegError::NotReady
                                                | scap_ffmpeg::AsFFmpegError::StagingBusy
                                        );
                                        if !readback_miss {
                                            warn!("Failed to convert D3D11 frame: {e:?}");
                                        } else {
                                            readback_misses += 1;
                                            if readback_misses == 1
                                                || readback_misses.is_multiple_of(90)
                                            {
                                                warn!(
                                                    readback_misses,
                                                    "Screen readback is missing deadlines; the encoder is duplicating the last frame"
                                                );
                                            }
                                        }
                                        duplicated_frames += 1;
                                        (
                                            last_ffmpeg_frame.as_ref().map(reference_video_frame),
                                            ts,
                                            Some(readback_elapsed),
                                        )
                                    }
                                }
                            }
                            Paced::Repeat(ts) => {
                                let Some(f) = &last_ffmpeg_frame else {
                                    continue;
                                };
                                duplicated_frames += 1;
                                (Some(reference_video_frame(f)), ts, None)
                            }
                            Paced::End => {
                                let mut drained = 0u64;
                                let drain_start = std::time::Instant::now();
                                let drain_timeout = Duration::from_millis(500);

                                loop {
                                    match video_rx.recv_timeout(Duration::from_millis(10)) {
                                        Ok(Some((frame, ts))) => {
                                            if let Ok(f) = frame.as_ffmpeg() {
                                                let normalized_ts =
                                                    normalize_timestamp(ts, &mut first_timestamp);
                                                if let Err(e) = encode_frame_fn(
                                                    f,
                                                    normalized_ts,
                                                    &mut slow_encode_count,
                                                    &mut total_frames,
                                                    &encoder_clone,
                                                ) {
                                                    warn!("Failed to encode drained frame: {e}");
                                                    break;
                                                }
                                                drained += 1;
                                            }
                                        }
                                        Ok(None) => break,
                                        Err(RecvTimeoutError::Timeout) => {
                                            if drain_start.elapsed() > drain_timeout {
                                                break;
                                            }
                                        }
                                        Err(RecvTimeoutError::Disconnected) => break,
                                    }
                                }

                                if drained > 0 {
                                    debug!(
                                        drained = drained,
                                        "Drained remaining frames before exit"
                                    );
                                }
                                break;
                            }
                        };

                    let Some(ffmpeg_frame) = ffmpeg_frame else {
                        continue;
                    };

                    if let Some(readback_elapsed) = readback_elapsed {
                        readback_frames += 1;
                        if readback_elapsed.as_millis() > SLOW_THRESHOLD_MS {
                            slow_convert_count += 1;
                            if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                                debug!(
                                    elapsed_ms = readback_elapsed.as_millis(),
                                    count = slow_convert_count,
                                    "D3D11 frame readback exceeded {}ms threshold",
                                    SLOW_THRESHOLD_MS
                                );
                            }
                        }
                    }

                    let normalized_ts = normalize_timestamp(timestamp, &mut first_timestamp);
                    if let Err(e) = encode_frame_fn(
                        ffmpeg_frame,
                        normalized_ts,
                        &mut slow_encode_count,
                        &mut total_frames,
                        &encoder_clone,
                    ) {
                        error!("Encoder mutex poisoned - encoder thread likely panicked, stopping");
                        return Err(e);
                    }
                }

                if total_frames > 0 {
                    let readback_slow_pct = if readback_frames > 0 {
                        100.0 * slow_convert_count as f64 / readback_frames as f64
                    } else {
                        0.0
                    };
                    debug!(
                        total_frames = total_frames,
                        duplicated_frames = duplicated_frames,
                        slow_readbacks = slow_convert_count,
                        readback_frames = readback_frames,
                        slow_encodes = slow_encode_count,
                        slow_readback_pct = format!("{readback_slow_pct:.1}%"),
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
            backend: EncoderBackend::Ffmpeg(encoder),
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started Windows M4S fragmented video encoder"
        );

        Ok(())
    }

    fn start_media_foundation_encoder(&mut self) -> anyhow::Result<bool> {
        let (Some(d3d_device), Some(pixel_format)) = (self.d3d_device.clone(), self.pixel_format)
        else {
            return Ok(false);
        };

        if self.encoder_preferences.should_force_software()
            || matches!(
                cap_frame_converter::detect_primary_gpu().map(|gpu| gpu.vendor),
                Some(cap_frame_converter::GpuVendor::Amd)
            )
        {
            return Ok(false);
        }

        let (video_tx, video_rx) = sync_channel::<Option<(screen_capture::ScreenFrame, Duration)>>(
            get_muxer_buffer_size(),
        );
        let (ready_tx, ready_rx) =
            sync_channel::<Result<Arc<Mutex<SegmentedPacketMuxer>>, String>>(1);

        let video_config = self.video_config;
        let output_size = self.output_size;
        let bpp = self.bpp;
        let segment_duration = self.segment_duration;
        let timed_fragments = self.timed_fragments;
        let base_path = self.base_path.clone();
        let pause_flag = self.pause.flag();
        let segment_tx = self.segment_tx.clone();
        let encoder_preferences = self.encoder_preferences.clone();
        let health_tx = self.health_tx.clone();

        let encoder_handle = std::thread::Builder::new()
            .name("win-m4s-mf-encoder".to_string())
            .spawn(move || {
                cap_mediafoundation_utils::thread_init();

                let disk_base_path = base_path.clone();
                let setup =
                    (|| -> anyhow::Result<(H264Encoder, Arc<Mutex<SegmentedPacketMuxer>>)> {
                        let input_size = SizeInt32 {
                            Width: video_config.width as i32,
                            Height: video_config.height as i32,
                        };
                        let (bitrate_width, bitrate_height) =
                            output_size.unwrap_or((video_config.width, video_config.height));
                        let output_size = output_size
                            .map(|(width, height)| SizeInt32 {
                                Width: width as i32,
                                Height: height as i32,
                            })
                            .unwrap_or(input_size);
                        let frame_rate = video_config.fps();
                        let bitrate = cap_enc_ffmpeg::h264::bitrate_for_bpp(
                            bitrate_width,
                            bitrate_height,
                            video_config.frame_rate,
                            bpp,
                        );

                        let encoder = H264Encoder::new_with_scaled_output_and_bitrate(
                            &d3d_device,
                            pixel_format,
                            input_size,
                            output_size,
                            frame_rate,
                            bitrate,
                        )?;
                        encoder.validate().map_err(|error| anyhow!("{error}"))?;
                        let extradata = encoder.sequence_header().ok_or_else(|| {
                            anyhow!("no H.264 sequence header before the first frame")
                        })?;
                        let mut muxer = SegmentedPacketMuxer::new(
                            base_path,
                            video_config,
                            (output_size.Width as u32, output_size.Height as u32),
                            segment_duration,
                            timed_fragments,
                            encoder.bitrate(),
                            &extradata,
                        )?;
                        if let Some(tx) = segment_tx {
                            muxer.set_segment_callback(tx);
                        }

                        Ok((encoder, Arc::new(Mutex::new(muxer))))
                    })();

                let (mut encoder, muxer) = match setup {
                    Ok(setup) => setup,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("{error:#}")));
                        return Ok(());
                    }
                };

                if ready_tx.send(Ok(muxer.clone())).is_err() {
                    return Ok(());
                }

                let mut pacer = FramePacer::new(video_config.fps());
                let mut last_frame: Option<screen_capture::ScreenFrame> = None;
                let mut first_timestamp: Option<Duration> = None;
                let mut failed_writes = 0u64;
                let mut disk_monitor = DiskSpaceMonitor::new();

                let result = encoder.run(
                    Arc::new(AtomicBool::default()),
                    || loop {
                        if matches!(
                            disk_monitor.poll(&disk_base_path, &health_tx),
                            super::core::DiskSpacePollResult::Exhausted { .. }
                                | super::core::DiskSpacePollResult::Stopped
                        ) {
                            return Ok(None);
                        }

                        let (texture, timestamp) = match pacer.next(&video_rx, &pause_flag) {
                            Paced::Frame(frame, timestamp) => {
                                let texture = frame.texture().clone();
                                // Keep the frame itself, not just its texture: the capture frame
                                // owns the surface, and dropping it lets WGC recycle the buffer
                                // while a repeat is still fed to the encoder.
                                last_frame = Some(frame);
                                (texture, timestamp)
                            }
                            Paced::Repeat(timestamp) => {
                                let Some(frame) = &last_frame else {
                                    continue;
                                };
                                (frame.texture().clone(), timestamp)
                            }
                            Paced::End => return Ok(None),
                        };
                        let normalized = normalize_timestamp(timestamp, &mut first_timestamp);

                        return Ok(Some((texture, duration_to_timespan(normalized))));
                    },
                    |sample| {
                        let packet = match cap_mediafoundation_ffmpeg::sample_to_packet(
                            &sample,
                            cap_mediafoundation_ffmpeg::MF_TIMEBASE,
                            0,
                        ) {
                            Ok(packet) => packet,
                            Err(error) => {
                                warn!("Failed to convert Media Foundation sample: {error}");
                                return Ok(());
                            }
                        };

                        let Ok(mut muxer) = muxer.lock() else {
                            return Ok(());
                        };
                        if let Err(error) =
                            muxer.write_packet(packet, cap_mediafoundation_ffmpeg::MF_TIMEBASE)
                        {
                            failed_writes += 1;
                            if failed_writes == 1 || failed_writes.is_multiple_of(300) {
                                warn!(
                                    failed_writes,
                                    "Failed to write Media Foundation sample: {error}"
                                );
                            }
                        }
                        Ok(())
                    },
                );

                match result {
                    Ok(status) => {
                        debug!(
                            frames = status.total_frames_encoded,
                            "Windows M4S Media Foundation encoder finished"
                        );
                        Ok(())
                    }
                    Err(error) => {
                        if error.should_fallback() {
                            encoder_preferences.force_software_only();
                        }
                        error!(
                            "Media Foundation encoder stopped; the rest of the video stream is dropped: {error}"
                        );
                        health_tx.emit(super::core::PipelineHealthEvent::MuxerCrashed {
                            reason: format!("Media Foundation encoder stopped: {error}"),
                        });

                        // Keep the channel connected while the recording runs: a closed channel
                        // makes send_video_frame fail and aborts the whole mux-video task, losing
                        // audio and the segments already written. Draining lets the pipeline stop
                        // normally and finish() finalize what exists.
                        while let Ok(message) = video_rx.recv() {
                            if message.is_none() {
                                break;
                            }
                        }

                        Err(error.into())
                    }
                }
            })?;

        match ready_rx.recv() {
            Ok(Ok(muxer)) => {
                self.state = Some(EncoderState {
                    video_tx,
                    backend: EncoderBackend::MediaFoundation(muxer),
                    encoder_handle: Some(encoder_handle),
                });
                self.started = true;
                info!(
                    path = %self.base_path.display(),
                    "Started Windows M4S fragmented video encoder (Media Foundation, texture input)"
                );
                Ok(true)
            }
            Ok(Err(reason)) => {
                warn!(
                    %reason,
                    "Media Foundation texture encoding unavailable; falling back to FFmpeg"
                );
                let _ = encoder_handle.join();
                Ok(false)
            }
            Err(_) => {
                warn!(
                    "Media Foundation encoder thread ended before signalling readiness; falling back to FFmpeg"
                );
                let _ = encoder_handle.join();
                Ok(false)
            }
        }
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

        if let Some(state) = &self.state {
            match state.video_tx.send(Some((frame.frame, adjusted_timestamp))) {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(_) => {
                    return Err(anyhow!("Windows M4S encoder channel disconnected"));
                }
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
    bpp: f32,
    output_size: Option<(u32, u32)>,
    state: Option<CameraEncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    health_tx: SharedHealthSender,
}

pub struct WindowsFragmentedM4SCameraMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
}

impl Default for WindowsFragmentedM4SCameraMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
            shared_pause_state: None,
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

        let mut muxer = Self {
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
                "muxer:windows-fragmented-camera",
            ),
            started: false,
            health_tx: SharedHealthSender::new(),
        };

        muxer.start_encoder()?;

        Ok(muxer)
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Windows M4S camera encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take()
            && let Err(error) = finish_segmented_encoder_impl(
                &mut state,
                timestamp,
                "Windows M4S camera encoder",
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

impl WindowsFragmentedM4SCameraMuxer {
    fn normalize_video_config_for_frame(&mut self, frame: &NativeCameraFrame) {
        let mut updated = false;

        let desired_pixel_format = match frame.pixel_format {
            cap_camera_windows::PixelFormat::UYVY422 => Pixel::YUYV422,
            _ => self.video_config.pixel_format,
        };

        if desired_pixel_format != self.video_config.pixel_format {
            self.video_config.pixel_format = desired_pixel_format;
            updated = true;
        }

        if frame.width != self.video_config.width {
            self.video_config.width = frame.width;
            updated = true;
        }

        if frame.height != self.video_config.height {
            self.video_config.height = frame.height;
            updated = true;
        }

        if updated {
            info!(
                width = self.video_config.width,
                height = self.video_config.height,
                pixel_format = ?self.video_config.pixel_format,
                "Adjusted camera video config to match native frame"
            );
        }
    }

    fn ensure_encoder_started(&mut self, frame: &NativeCameraFrame) -> anyhow::Result<()> {
        if self.started {
            return Ok(());
        }

        self.normalize_video_config_for_frame(frame);
        self.start_encoder()
    }

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
            bpp: self.bpp,
            output_size: self.output_size,
            prefer_videotoolbox_hw_input: false,
        };

        let encoder = SegmentedVideoEncoder::init_with_timed_fragments(
            self.base_path.clone(),
            self.video_config,
            encoder_config,
            true,
        )?;
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();

        let video_config = self.video_config;
        let health_tx = self.health_tx.clone();
        let base_path = self.base_path.clone();
        let pause_flag = self.pause.flag();
        let encoder_handle = std::thread::Builder::new()
            .name("win-m4s-camera-segment-encoder".to_string())
            .spawn(move || {
                cap_mediafoundation_utils::thread_init();

                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!(
                        "Failed to send ready signal - camera receiver dropped"
                    ));
                }

                let mut pacer = FramePacer::new(video_config.fps());
                let mut last_frame: Option<NativeCameraFrame> = None;
                let mut first_timestamp: Option<Duration> = None;

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                let mut duplicated_frames = 0u64;
                let mut disk_monitor = DiskSpaceMonitor::new();
                let mut disk_exhausted = false;
                let mut mjpeg_decoder = MjpegDecoder::default();
                const SLOW_THRESHOLD_MS: u128 = 5;

                let normalize_timestamp =
                    |ts: Duration, first: &mut Option<Duration>| -> Duration {
                        if let Some(first_ts) = *first {
                            ts.checked_sub(first_ts).unwrap_or(Duration::ZERO)
                        } else {
                            *first = Some(ts);
                            Duration::ZERO
                        }
                    };

                let encode_camera_frame_fn =
                    |camera_frame: &NativeCameraFrame,
                     timestamp: Duration,
                     slow_convert_count: &mut u32,
                     slow_encode_count: &mut u32,
                     total_frames: &mut u64,
                     encoder: &Arc<Mutex<SegmentedVideoEncoder>>,
                     mjpeg_decoder: &mut MjpegDecoder|
                     -> anyhow::Result<()> {
                        let convert_start = std::time::Instant::now();
                        let ffmpeg_frame_result = camera_frame_to_ffmpeg(camera_frame, mjpeg_decoder);
                        let convert_elapsed_ms = convert_start.elapsed().as_millis();

                        if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                            *slow_convert_count += 1;
                            if *slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                                debug!(
                                    elapsed_ms = convert_elapsed_ms,
                                    count = *slow_convert_count,
                                    "Camera frame conversion exceeded {}ms threshold",
                                    SLOW_THRESHOLD_MS
                                );
                            }
                        }

                        match ffmpeg_frame_result {
                            Ok(ffmpeg_frame) => {
                                let encode_start = std::time::Instant::now();

                                match encoder.lock() {
                                    Ok(mut enc) => {
                                        if let Err(e) = enc.queue_frame(ffmpeg_frame, timestamp) {
                                            warn!("Failed to encode camera frame: {e}");
                                        }
                                    }
                                    Err(_) => {
                                        return Err(anyhow!(
                                            "Camera encoder mutex poisoned - all subsequent frames would be lost"
                                        ));
                                    }
                                }

                                let encode_elapsed_ms = encode_start.elapsed().as_millis();

                                if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                                    *slow_encode_count += 1;
                                    if *slow_encode_count <= 5
                                        || slow_encode_count.is_multiple_of(100)
                                    {
                                        debug!(
                                            elapsed_ms = encode_elapsed_ms,
                                            count = *slow_encode_count,
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

                        *total_frames += 1;
                        Ok(())
                    };

                loop {
                    if matches!(
                        disk_monitor.poll(&base_path, &health_tx),
                        super::core::DiskSpacePollResult::Exhausted { .. }
                            | super::core::DiskSpacePollResult::Stopped
                    ) {
                        disk_exhausted = true;
                    }
                    if disk_exhausted {
                        break;
                    }

                    let (camera_frame, timestamp) = match pacer.next(&video_rx, &pause_flag) {
                        Paced::Frame(frame, ts) => {
                            last_frame = Some(frame.clone());
                            (frame, ts)
                        }
                        Paced::Repeat(ts) => {
                            let Some(frame) = &last_frame else {
                                continue;
                            };
                            duplicated_frames += 1;
                            (frame.clone(), ts)
                        }
                        Paced::End => {
                            let mut drained = 0u64;
                            let drain_start = std::time::Instant::now();
                            let drain_timeout = Duration::from_millis(500);

                            loop {
                                match video_rx.recv_timeout(Duration::from_millis(10)) {
                                    Ok(Some((frame, ts))) => {
                                        let normalized_ts =
                                            normalize_timestamp(ts, &mut first_timestamp);
                                        if let Err(e) = encode_camera_frame_fn(
                                            &frame,
                                            normalized_ts,
                                            &mut slow_convert_count,
                                            &mut slow_encode_count,
                                            &mut total_frames,
                                            &encoder_clone,
                                            &mut mjpeg_decoder,
                                        ) {
                                            warn!("Failed to encode drained camera frame: {e}");
                                            break;
                                        }
                                        drained += 1;
                                    }
                                    Ok(None) => break,
                                    Err(RecvTimeoutError::Timeout) => {
                                        if drain_start.elapsed() > drain_timeout {
                                            break;
                                        }
                                    }
                                    Err(RecvTimeoutError::Disconnected) => break,
                                }
                            }

                            if drained > 0 {
                                debug!(
                                    drained = drained,
                                    "Drained remaining camera frames before exit"
                                );
                            }
                            break;
                        }
                    };

                    let normalized_ts = normalize_timestamp(timestamp, &mut first_timestamp);
                    if let Err(e) = encode_camera_frame_fn(
                        &camera_frame,
                        normalized_ts,
                        &mut slow_convert_count,
                        &mut slow_encode_count,
                        &mut total_frames,
                        &encoder_clone,
                        &mut mjpeg_decoder,
                    ) {
                        error!("Camera encoder mutex poisoned - encoder thread likely panicked, stopping");
                        return Err(e);
                    }
                }

                if total_frames > 0 {
                    debug!(
                        total_frames = total_frames,
                        duplicated_frames = duplicated_frames,
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

        self.ensure_encoder_started(&frame)?;

        if let Some(state) = &self.state {
            match state.video_tx.send(Some((frame, adjusted_timestamp))) {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(_) => {
                    return Err(anyhow!("Windows M4S camera encoder channel disconnected"));
                }
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

#[cfg(test)]
mod tests {
    use super::reference_video_frame;

    #[test]
    fn instant_fragment_frames_reuse_reference_counted_pixels() {
        let mut original = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 16, 12);
        original.set_pts(Some(91));
        original.data_mut(0)[0] = 63;
        let retained = reference_video_frame(&original);
        let replay = reference_video_frame(&retained);

        assert_eq!(retained.data(0).as_ptr(), original.data(0).as_ptr());
        assert_eq!(replay.data(0).as_ptr(), original.data(0).as_ptr());
        assert_eq!(replay.pts(), Some(91));
        let buffer = unsafe { (*original.as_ptr()).buf[0] };
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(buffer) }, 3);

        drop(original);
        drop(retained);

        assert_eq!(replay.data(0)[0], 63);
    }
}
