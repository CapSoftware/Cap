use crate::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoFrame, VideoMuxer, screen_capture};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::aac::AACEncoder;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::Timestamp;
use futures::channel::oneshot;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{RecvTimeoutError, SyncSender, TrySendError, sync_channel},
    },
    time::Duration,
};
use tracing::*;

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
                        "Windows MP4 muxer frame drop rate exceeds 5% threshold"
                    );
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "Windows MP4 muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}
use windows::{
    Foundation::TimeSpan,
    Graphics::SizeInt32,
    Win32::Graphics::{
        Direct3D11::ID3D11Device,
        Dxgi::Common::{
            DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_FORMAT_R8G8B8A8_UNORM,
            DXGI_FORMAT_YUY2,
        },
    },
};

pub struct WindowsMuxer {
    video_tx: SyncSender<Option<(screen_capture::ScreenFrame, Duration)>>,
    output: Arc<Mutex<ffmpeg::format::context::Output>>,
    audio_encoder: Option<AACEncoder>,
    frame_drops: FrameDropTracker,
}

pub struct WindowsMuxerConfig {
    pub pixel_format: DXGI_FORMAT,
    pub d3d_device: ID3D11Device,
    pub frame_rate: u32,
    pub bitrate_multiplier: f32,
    pub output_size: Option<SizeInt32>,
    pub encoder_preferences: crate::capture_pipeline::EncoderPreferences,
    pub fragmented: bool,
    pub frag_duration_us: i64,
}

impl Muxer for WindowsMuxer {
    type Config = WindowsMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        tasks: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let video_config =
            video_config.ok_or_else(|| anyhow!("invariant: video config expected"))?;
        let input_size = SizeInt32 {
            Width: video_config.width as i32,
            Height: video_config.height as i32,
        };
        let output_size = config.output_size.unwrap_or(input_size);
        let fragmented = config.fragmented;
        let frag_duration_us = config.frag_duration_us;
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Windows MP4 muxer encoder channel buffer size"
        );
        let (video_tx, video_rx) =
            sync_channel::<Option<(screen_capture::ScreenFrame, Duration)>>(buffer_size);

        let mut output = ffmpeg::format::output(&output_path)?;

        if fragmented {
            cap_mediafoundation_ffmpeg::set_fragmented_mp4_options(&mut output, frag_duration_us)?;
        }
        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()?;

        let output = Arc::new(Mutex::new(output));
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<()>>();

        {
            let output = output.clone();
            let pause_flag = pause_flag.clone();

            tasks.spawn_thread("windows-encoder", move || {
                cap_mediafoundation_utils::thread_init();

                let encoder_preferences = &config.encoder_preferences;

                let encoder = (|| {
                    let fallback = |reason: Option<String>| {
                        use tracing::{error, info};

                        encoder_preferences.force_software_only();
                        if let Some(reason) = reason.as_ref() {
                            error!("Falling back to software H264 encoder: {reason}");
                        } else {
                            info!("Falling back to software H264 encoder");
                        }

                        let fallback_width = if output_size.Width > 0 {
                            output_size.Width as u32
                        } else {
                            video_config.width
                        };
                        let fallback_height = if output_size.Height > 0 {
                            output_size.Height as u32
                        } else {
                            video_config.height
                        };

                        let mut output_guard = match output.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => {
                                return Err(anyhow!(
                                    "ScreenSoftwareEncoder: failed to lock output mutex: {}",
                                    poisoned
                                ));
                            }
                        };

                        cap_enc_ffmpeg::h264::H264Encoder::builder(video_config)
                            .with_output_size(fallback_width, fallback_height)
                            .and_then(|builder| builder.build(&mut output_guard))
                            .map(either::Right)
                            .map_err(|e| anyhow!("ScreenSoftwareEncoder/{e}"))
                    };

                    if encoder_preferences.should_force_software() {
                        return fallback(None);
                    }

                    match cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                        &config.d3d_device,
                        config.pixel_format,
                        input_size,
                        output_size,
                        config.frame_rate,
                        config.bitrate_multiplier,
                    ) {
                        Ok(encoder) => {
                            if let Err(e) = encoder.validate() {
                                return fallback(Some(format!(
                                    "Hardware encoder validation failed: {e}"
                                )));
                            }

                            let width = match u32::try_from(output_size.Width) {
                                Ok(width) if width > 0 => width,
                                _ => {
                                    return fallback(Some(format!(
                                        "Invalid output width: {}",
                                        output_size.Width
                                    )));
                                }
                            };

                            let height = match u32::try_from(output_size.Height) {
                                Ok(height) if height > 0 => height,
                                _ => {
                                    return fallback(Some(format!(
                                        "Invalid output height: {}",
                                        output_size.Height
                                    )));
                                }
                            };

                            let muxer = {
                                let mut output_guard = match output.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => {
                                        return fallback(Some(format!(
                                            "Failed to lock output mutex: {poisoned}"
                                        )));
                                    }
                                };

                                cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                                    &mut output_guard,
                                    cap_mediafoundation_ffmpeg::MuxerConfig {
                                        width,
                                        height,
                                        fps: config.frame_rate,
                                        bitrate: encoder.bitrate(),
                                        fragmented,
                                        frag_duration_us,
                                    },
                                )
                            };

                            match muxer {
                                Ok(muxer) => Ok(either::Left((encoder, muxer))),
                                Err(err) => fallback(Some(err.to_string())),
                            }
                        }
                        Err(err) => fallback(Some(err.to_string())),
                    }
                })();

                let encoder = match encoder {
                    Ok(encoder) => {
                        if ready_tx.send(Ok(())).is_err() {
                            error!("Failed to send ready signal - receiver dropped");
                            return Ok(());
                        }
                        encoder
                    }
                    Err(e) => {
                        error!("Encoder setup failed: {:#}", e);
                        let _ = ready_tx.send(Err(anyhow!("{e}")));
                        return Err(anyhow!("{e}"));
                    }
                };

                fn normalize_timestamp(ts: Duration, first: &mut Option<Duration>) -> Duration {
                    match *first {
                        Some(first_ts) => ts.saturating_sub(first_ts),
                        None => {
                            *first = Some(ts);
                            Duration::ZERO
                        }
                    }
                }

                match encoder {
                    either::Left((mut encoder, mut muxer)) => {
                        trace!("Running native encoder with frame pacing");
                        let frame_interval = Duration::from_secs_f64(1.0 / config.frame_rate as f64);
                        let mut last_texture: Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D> = None;
                        let mut first_timestamp: Option<Duration> = None;
                        let mut last_timestamp: Option<Duration> = None;
                        let mut frame_count: u64 = 0;
                        let mut frames_reused: u64 = 0;

                        let result = encoder.run(
                            Arc::new(AtomicBool::default()),
                            || {
                                loop {
                                    match video_rx.recv_timeout(frame_interval) {
                                        Ok(Some((frame, timestamp))) => {
                                            last_texture = Some(frame.texture().clone());
                                            last_timestamp = Some(timestamp);
                                        }
                                        Ok(None) => {
                                            trace!("End of stream signal received");
                                            return Ok(None);
                                        }
                                        Err(RecvTimeoutError::Timeout) => {
                                            if pause_flag.load(Ordering::Acquire) {
                                                last_timestamp = None;
                                                continue;
                                            } else if let Some(last_ts) = last_timestamp {
                                                let new_ts = last_ts.saturating_add(frame_interval);
                                                last_timestamp = Some(new_ts);
                                                frames_reused += 1;
                                                if frames_reused.is_multiple_of(30) {
                                                    debug!(
                                                        frames_reused = frames_reused,
                                                        frame_count = frame_count,
                                                        "Frame pacing: reusing frames due to slow capture"
                                                    );
                                                }
                                            }
                                        }
                                        Err(RecvTimeoutError::Disconnected) => {
                                            trace!("Channel disconnected");
                                            return Ok(None);
                                        }
                                    }

                                    if let (Some(texture), Some(ts)) = (&last_texture, last_timestamp) {
                                        let normalized_ts = normalize_timestamp(ts, &mut first_timestamp);
                                        frame_count += 1;
                                        let frame_time = duration_to_timespan(normalized_ts);
                                        return Ok(Some((texture.clone(), frame_time)));
                                    } else {
                                        match video_rx.recv() {
                                            Ok(Some((frame, timestamp))) => {
                                                let texture = frame.texture().clone();
                                                last_texture = Some(texture.clone());
                                                last_timestamp = Some(timestamp);
                                                let normalized_ts =
                                                    normalize_timestamp(timestamp, &mut first_timestamp);
                                                frame_count = 1;
                                                let frame_time = duration_to_timespan(normalized_ts);
                                                return Ok(Some((texture, frame_time)));
                                            }
                                            Ok(None) | Err(_) => return Ok(None),
                                        }
                                    }
                                }
                            },
                            |output_sample| {
                                let Ok(mut output) = output.lock() else {
                                    tracing::error!("Failed to lock output mutex - poisoned");
                                    return Ok(());
                                };

                                if let Err(e) = muxer.write_sample(&output_sample, &mut output) {
                                    tracing::error!("WriteSample failed: {e}");
                                }

                                Ok(())
                            },
                        );

                        match result {
                            Ok(health_status) => {
                                debug!(
                                    "Hardware encoder completed: {} frames encoded",
                                    health_status.total_frames_encoded
                                );
                                Ok(())
                            }
                            Err(e) => {
                                if e.should_fallback() {
                                    error!(
                                        "Hardware encoder failed with recoverable error, marking for software fallback: {}",
                                        e
                                    );
                                    encoder_preferences.force_software_only();
                                }
                                Err(anyhow!("Hardware encoder error: {}", e))
                            }
                        }
                    }
                    either::Right(mut encoder) => {
                        trace!("Running software encoder with frame pacing");
                        let frame_interval = Duration::from_secs_f64(1.0 / config.frame_rate as f64);
                        let mut last_ffmpeg_frame: Option<ffmpeg::frame::Video> = None;
                        let mut first_timestamp: Option<Duration> = None;
                        let mut last_timestamp: Option<Duration> = None;

                        loop {
                            let (ffmpeg_frame, ts) = match video_rx.recv_timeout(frame_interval) {
                                Ok(Some((frame, timestamp))) => {
                                    last_timestamp = Some(timestamp);
                                    match frame.as_ffmpeg() {
                                        Ok(f) => {
                                            last_ffmpeg_frame = Some(f.clone());
                                            (Some(f), timestamp)
                                        }
                                        Err(e) => {
                                            warn!("Failed to convert frame: {e:?}");
                                            (last_ffmpeg_frame.clone(), timestamp)
                                        }
                                    }
                                }
                                Ok(None) => break,
                                Err(RecvTimeoutError::Timeout) => {
                                    if pause_flag.load(Ordering::Acquire) {
                                        last_timestamp = None;
                                        continue;
                                    }
                                    if let Some(last_ts) = last_timestamp {
                                        let new_ts = last_ts.saturating_add(frame_interval);
                                        last_timestamp = Some(new_ts);
                                        (last_ffmpeg_frame.clone(), new_ts)
                                    } else {
                                        continue;
                                    }
                                }
                                Err(RecvTimeoutError::Disconnected) => break,
                            };

                            let Some(ffmpeg_frame) = ffmpeg_frame else {
                                match video_rx.recv() {
                                    Ok(Some((frame, timestamp))) => {
                                        last_timestamp = Some(timestamp);
                                        if let Ok(f) = frame.as_ffmpeg() {
                                            last_ffmpeg_frame = Some(f);
                                        }
                                    }
                                    Ok(None) | Err(_) => break,
                                }
                                continue;
                            };

                            let normalized_ts = normalize_timestamp(ts, &mut first_timestamp);

                            let Ok(mut output) = output.lock() else {
                                continue;
                            };

                            encoder
                                .queue_frame(ffmpeg_frame, normalized_ts, &mut output)
                                .context("queue_frame")?;
                        }

                        Ok(())
                    }
                }
            });
        }

        ready_rx
            .await
            .map_err(|_| anyhow!("Encoder thread ended unexpectedly"))??;

        output
            .lock()
            .map_err(|_| anyhow!("Output mutex poisoned during header write"))?
            .write_header()?;

        Ok(Self {
            video_tx,
            output,
            audio_encoder,
            frame_drops: FrameDropTracker::new(),
        })
    }

    fn stop(&mut self) {
        let _ = self.video_tx.send(None);
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| anyhow!("Failed to lock output"))?;
        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut output))
            .unwrap_or(Ok(()));

        output.write_trailer()?;

        Ok(audio_result.map_err(Into::into))
    }
}

impl VideoMuxer for WindowsMuxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        match self.video_tx.try_send(Some((frame.frame, timestamp))) {
            Ok(()) => {
                self.frame_drops.record_frame();
            }
            Err(TrySendError::Full(_)) => {
                self.frame_drops.record_drop();
            }
            Err(TrySendError::Disconnected(_)) => {
                trace!("Windows MP4 encoder channel disconnected");
            }
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(encoder) = self.audio_encoder.as_mut()
            && let Ok(mut output) = self.output.lock()
        {
            encoder.send_frame(frame.inner, timestamp, &mut output)?;
        }

        Ok(())
    }
}

fn duration_to_timespan(duration: Duration) -> TimeSpan {
    const TICKS_PER_SEC: u64 = 10_000_000;
    const NANOS_PER_TICK: u32 = 100;

    let secs_ticks = duration.as_secs().saturating_mul(TICKS_PER_SEC);
    let nanos_ticks = (duration.subsec_nanos() / NANOS_PER_TICK) as u64;
    let total_ticks = secs_ticks.saturating_add(nanos_ticks);
    let clamped = total_ticks.min(i64::MAX as u64);

    TimeSpan {
        Duration: clamped as i64,
    }
}

#[derive(Clone)]
pub struct NativeCameraFrame {
    pub buffer:
        std::sync::Arc<std::sync::Mutex<windows::Win32::Media::MediaFoundation::IMFMediaBuffer>>,
    pub pixel_format: cap_camera_windows::PixelFormat,
    pub width: u32,
    pub height: u32,
    pub is_bottom_up: bool,
    pub timestamp: Timestamp,
}

unsafe impl Send for NativeCameraFrame {}
unsafe impl Sync for NativeCameraFrame {}

impl VideoFrame for NativeCameraFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

impl NativeCameraFrame {
    pub fn dxgi_format(&self) -> DXGI_FORMAT {
        match self.pixel_format {
            cap_camera_windows::PixelFormat::NV12 => DXGI_FORMAT_NV12,
            cap_camera_windows::PixelFormat::YUYV422 | cap_camera_windows::PixelFormat::UYVY422 => {
                DXGI_FORMAT_YUY2
            }
            cap_camera_windows::PixelFormat::ARGB | cap_camera_windows::PixelFormat::RGB32 => {
                DXGI_FORMAT_B8G8R8A8_UNORM
            }
            cap_camera_windows::PixelFormat::RGB24 => DXGI_FORMAT_R8G8B8A8_UNORM,
            _ => DXGI_FORMAT_NV12,
        }
    }
}

pub struct WindowsCameraMuxer {
    video_tx: SyncSender<Option<(NativeCameraFrame, Duration)>>,
    output: Arc<Mutex<ffmpeg::format::context::Output>>,
    audio_encoder: Option<AACEncoder>,
    frame_drops: FrameDropTracker,
}

pub struct WindowsCameraMuxerConfig {
    pub output_height: Option<u32>,
    pub fragmented: bool,
    pub frag_duration_us: i64,
    pub encoder_preferences: crate::capture_pipeline::EncoderPreferences,
    pub expected_pixel_format: Option<ffmpeg::format::Pixel>,
}

impl Default for WindowsCameraMuxerConfig {
    fn default() -> Self {
        Self {
            output_height: None,
            fragmented: false,
            frag_duration_us: 2_000_000,
            encoder_preferences: crate::capture_pipeline::EncoderPreferences::new(),
            expected_pixel_format: None,
        }
    }
}

fn ffmpeg_pixel_to_dxgi(pixel: ffmpeg::format::Pixel) -> DXGI_FORMAT {
    match pixel {
        ffmpeg::format::Pixel::NV12 => DXGI_FORMAT_NV12,
        ffmpeg::format::Pixel::YUYV422 | ffmpeg::format::Pixel::UYVY422 => DXGI_FORMAT_YUY2,
        ffmpeg::format::Pixel::BGRA | ffmpeg::format::Pixel::RGBA => DXGI_FORMAT_B8G8R8A8_UNORM,
        ffmpeg::format::Pixel::BGR24 | ffmpeg::format::Pixel::RGB24 => DXGI_FORMAT_R8G8B8A8_UNORM,
        _ => DXGI_FORMAT_NV12,
    }
}

impl Muxer for WindowsCameraMuxer {
    type Config = WindowsCameraMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        tasks: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let video_config =
            video_config.ok_or_else(|| anyhow!("invariant: video config expected"))?;

        let input_size = SizeInt32 {
            Width: video_config.width as i32,
            Height: video_config.height as i32,
        };

        let output_height = config.output_height.unwrap_or(video_config.height);
        let output_width = (video_config.width * output_height) / video_config.height;
        let output_width = output_width & !1;
        let output_height = output_height & !1;

        let output_size = SizeInt32 {
            Width: output_width as i32,
            Height: output_height as i32,
        };

        let frame_rate = video_config.fps();
        let bitrate_multiplier = 0.2;
        let fragmented = config.fragmented;
        let frag_duration_us = config.frag_duration_us;

        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Windows MP4 camera muxer encoder channel buffer size"
        );
        let (video_tx, video_rx) =
            sync_channel::<Option<(NativeCameraFrame, Duration)>>(buffer_size);

        let mut output = ffmpeg::format::output(&output_path)?;

        if fragmented {
            cap_mediafoundation_ffmpeg::set_fragmented_mp4_options(&mut output, frag_duration_us)?;
        }

        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()?;

        let output = Arc::new(Mutex::new(output));
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<()>>();

        let expected_input_format = config
            .expected_pixel_format
            .map(ffmpeg_pixel_to_dxgi)
            .unwrap_or_else(|| ffmpeg_pixel_to_dxgi(video_config.pixel_format));

        {
            let output = output.clone();
            let pause_flag = pause_flag.clone();
            let encoder_preferences = config.encoder_preferences;

            tasks.spawn_thread("windows-camera-encoder", move || {
                cap_mediafoundation_utils::thread_init();

                let d3d_device = match crate::capture_pipeline::create_d3d_device() {
                    Ok(device) => device,
                    Err(e) => {
                        let _ = ready_tx.send(Err(anyhow!("Failed to create D3D device: {e}")));
                        return Err(anyhow!("Failed to create D3D device: {e}"));
                    }
                };

                let input_format = expected_input_format;

                let encoder = (|| {
                    let fallback = |reason: Option<String>| {
                        encoder_preferences.force_software_only();
                        if let Some(reason) = reason.as_ref() {
                            error!(
                                "Falling back to software H264 encoder for camera: {reason}"
                            );
                        } else {
                            info!("Using software H264 encoder for camera");
                        }

                        let mut output_guard = match output.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => {
                                return Err(anyhow!(
                                    "CameraSoftwareEncoder: failed to lock output mutex: {}",
                                    poisoned
                                ));
                            }
                        };

                        cap_enc_ffmpeg::h264::H264Encoder::builder(video_config)
                            .with_output_size(output_width, output_height)
                            .and_then(|builder| builder.build(&mut output_guard))
                            .map(either::Right)
                            .map_err(|e| anyhow!("CameraSoftwareEncoder/{e}"))
                    };

                    if encoder_preferences.should_force_software() {
                        return fallback(None);
                    }

                    match cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                        &d3d_device,
                        input_format,
                        input_size,
                        output_size,
                        frame_rate,
                        bitrate_multiplier,
                    ) {
                        Ok(encoder) => {
                            if let Err(e) = encoder.validate() {
                                return fallback(Some(format!(
                                    "Camera hardware encoder validation failed: {e}"
                                )));
                            }

                            let muxer = {
                                let mut output_guard = match output.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => {
                                        return fallback(Some(format!(
                                            "Failed to lock output mutex: {poisoned}"
                                        )));
                                    }
                                };

                                cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                                    &mut output_guard,
                                    cap_mediafoundation_ffmpeg::MuxerConfig {
                                        width: output_width,
                                        height: output_height,
                                        fps: frame_rate,
                                        bitrate: encoder.bitrate(),
                                        fragmented,
                                        frag_duration_us,
                                    },
                                )
                            };

                            match muxer {
                                Ok(muxer) => Ok(either::Left((encoder, muxer))),
                                Err(err) => fallback(Some(err.to_string())),
                            }
                        }
                        Err(err) => fallback(Some(err.to_string())),
                    }
                })();

                let encoder = match encoder {
                    Ok(encoder) => {
                        if ready_tx.send(Ok(())).is_err() {
                            error!("Failed to send ready signal - receiver dropped");
                            return Ok(());
                        }
                        encoder
                    }
                    Err(e) => {
                        error!("Camera encoder setup failed: {:#}", e);
                        let _ = ready_tx.send(Err(anyhow!("{e}")));
                        return Err(anyhow!("{e}"));
                    }
                };

                fn normalize_camera_timestamp(ts: Duration, first: &mut Option<Duration>) -> Duration {
                    match *first {
                        Some(first_ts) => ts.saturating_sub(first_ts),
                        None => {
                            *first = Some(ts);
                            Duration::ZERO
                        }
                    }
                }

                match encoder {
                    either::Left((mut encoder, mut muxer)) => {
                        info!(
                            "Windows camera encoder started (hardware) with frame pacing: {:?} {}x{} -> NV12 {}x{} @ {}fps",
                            input_format,
                            input_size.Width,
                            input_size.Height,
                            output_size.Width,
                            output_size.Height,
                            frame_rate
                        );

                        let frame_interval = Duration::from_secs_f64(1.0 / frame_rate as f64);
                        let mut last_frame: Option<NativeCameraFrame> = None;
                        let mut first_timestamp: Option<Duration> = None;
                        let mut last_timestamp: Option<Duration> = None;
                        let mut frame_count = 0u64;
                        let mut camera_buffers = CameraBuffers::new();

                        let result = encoder.run(
                            Arc::new(AtomicBool::default()),
                            || {
                                loop {
                                    match video_rx.recv_timeout(frame_interval) {
                                        Ok(Some((frame, timestamp))) => {
                                            last_frame = Some(frame);
                                            last_timestamp = Some(timestamp);
                                        }
                                        Ok(None) => {
                                            trace!("End of camera stream signal received");
                                            return Ok(None);
                                        }
                                        Err(RecvTimeoutError::Timeout) => {
                                            if pause_flag.load(Ordering::Acquire) {
                                                last_timestamp = None;
                                                continue;
                                            } else if let Some(last_ts) = last_timestamp {
                                                let new_ts = last_ts.saturating_add(frame_interval);
                                                last_timestamp = Some(new_ts);
                                            }
                                        }
                                        Err(RecvTimeoutError::Disconnected) => {
                                            trace!("Camera channel disconnected");
                                            return Ok(None);
                                        }
                                    }

                                    if let (Some(frame), Some(ts)) = (&last_frame, last_timestamp) {
                                        let normalized_ts =
                                            normalize_camera_timestamp(ts, &mut first_timestamp);
                                        frame_count += 1;
                                        if frame_count.is_multiple_of(30) {
                                            debug!(
                                                "Windows camera encoder: processed {} frames",
                                                frame_count
                                            );
                                        }
                                        let texture =
                                            upload_mf_buffer_to_texture(&d3d_device, frame, &mut camera_buffers)?;
                                        return Ok(Some((texture, duration_to_timespan(normalized_ts))));
                                    } else {
                                        match video_rx.recv() {
                                            Ok(Some((frame, timestamp))) => {
                                                last_frame = Some(frame.clone());
                                                last_timestamp = Some(timestamp);
                                                let normalized_ts = normalize_camera_timestamp(
                                                    timestamp,
                                                    &mut first_timestamp,
                                                );
                                                frame_count = 1;
                                                let texture = upload_mf_buffer_to_texture(
                                                    &d3d_device,
                                                    &frame,
                                                    &mut camera_buffers,
                                                )?;
                                                return Ok(Some((texture, duration_to_timespan(normalized_ts))));
                                            }
                                            Ok(None) | Err(_) => return Ok(None),
                                        }
                                    }
                                }
                            },
                            |output_sample| {
                                let mut output = match output.lock() {
                                    Ok(o) => o,
                                    Err(_) => {
                                        tracing::error!("Camera output mutex poisoned during write");
                                        return Err(anyhow!("Camera output mutex poisoned"));
                                    }
                                };
                                if let Err(e) = muxer.write_sample(&output_sample, &mut output)
                                {
                                    tracing::error!("Camera WriteSample failed: {e}");
                                }
                                Ok(())
                            },
                        );

                        match result {
                            Ok(health_status) => {
                                info!(
                                    "Windows camera encoder finished (hardware): {} frames encoded",
                                    health_status.total_frames_encoded
                                );
                            }
                            Err(e) => {
                                if e.should_fallback() {
                                    error!(
                                        "Camera hardware encoder failed with recoverable error, marking for software fallback: {}",
                                        e
                                    );
                                    encoder_preferences.force_software_only();
                                }
                                return Err(anyhow!("Camera hardware encoder error: {}", e));
                            }
                        }

                        Ok(())
                    }
                    either::Right(mut encoder) => {
                        info!(
                            "Windows camera encoder started (software) with frame pacing: {}x{} -> {}x{} @ {}fps",
                            video_config.width,
                            video_config.height,
                            output_width,
                            output_height,
                            frame_rate
                        );

                        let frame_interval = Duration::from_secs_f64(1.0 / frame_rate as f64);
                        let mut last_frame: Option<NativeCameraFrame> = None;
                        let mut first_timestamp: Option<Duration> = None;
                        let mut last_timestamp: Option<Duration> = None;
                        let mut frame_count = 0u64;

                        loop {
                            let (frame_to_encode, ts) = match video_rx.recv_timeout(frame_interval) {
                                Ok(Some((frame, timestamp))) => {
                                    last_frame = Some(frame.clone());
                                    last_timestamp = Some(timestamp);
                                    (Some(frame), timestamp)
                                }
                                Ok(None) => break,
                                Err(RecvTimeoutError::Timeout) => {
                                    if pause_flag.load(Ordering::Acquire) {
                                        last_timestamp = None;
                                        continue;
                                    }
                                    if let Some(last_ts) = last_timestamp {
                                        let new_ts = last_ts.saturating_add(frame_interval);
                                        last_timestamp = Some(new_ts);
                                        (last_frame.clone(), new_ts)
                                    } else {
                                        continue;
                                    }
                                }
                                Err(RecvTimeoutError::Disconnected) => break,
                            };

                            let Some(frame) = frame_to_encode else {
                                match video_rx.recv() {
                                    Ok(Some((frame, timestamp))) => {
                                        last_frame = Some(frame.clone());
                                        last_timestamp = Some(timestamp);
                                    }
                                    Ok(None) | Err(_) => break,
                                }
                                continue;
                            };

                            let normalized_ts = normalize_camera_timestamp(ts, &mut first_timestamp);

                            let ffmpeg_frame = match camera_frame_to_ffmpeg(&frame) {
                                Ok(f) => f,
                                Err(e) => {
                                    error!("Failed to convert camera frame: {e}");
                                    continue;
                                }
                            };

                            let Ok(mut output_guard) = output.lock() else {
                                continue;
                            };

                            if let Err(e) = encoder
                                .queue_frame(ffmpeg_frame, normalized_ts, &mut output_guard)
                                .context("queue camera frame")
                            {
                                error!("Failed to queue camera frame: {e}");
                                continue;
                            }

                            frame_count += 1;
                            if frame_count.is_multiple_of(30) {
                                debug!(
                                    "Windows camera encoder (software): processed {} frames",
                                    frame_count
                                );
                            }
                        }

                        info!(
                            "Windows camera encoder finished (software): {} frames encoded",
                            frame_count
                        );
                        Ok(())
                    }
                }
            });
        }

        ready_rx
            .await
            .map_err(|_| anyhow!("Camera encoder thread ended unexpectedly"))??;

        output
            .lock()
            .map_err(|_| anyhow!("Camera output mutex poisoned during header write"))?
            .write_header()?;

        Ok(Self {
            video_tx,
            output,
            audio_encoder,
            frame_drops: FrameDropTracker::new(),
        })
    }

    fn stop(&mut self) {
        let _ = self.video_tx.send(None);
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| anyhow!("Failed to lock output"))?;
        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut output))
            .unwrap_or(Ok(()));

        output.write_trailer()?;

        Ok(audio_result.map_err(Into::into))
    }
}

impl VideoMuxer for WindowsCameraMuxer {
    type VideoFrame = NativeCameraFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        match self.video_tx.try_send(Some((frame, timestamp))) {
            Ok(()) => {
                self.frame_drops.record_frame();
            }
            Err(TrySendError::Full(_)) => {
                self.frame_drops.record_drop();
            }
            Err(TrySendError::Disconnected(_)) => {
                trace!("Windows MP4 camera encoder channel disconnected");
            }
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsCameraMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(encoder) = self.audio_encoder.as_mut()
            && let Ok(mut output) = self.output.lock()
        {
            encoder.send_frame(frame.inner, timestamp, &mut output)?;
        }

        Ok(())
    }
}

pub struct CameraBuffers {
    uyvy_buffer: Vec<u8>,
    flip_buffer: Vec<u8>,
}

impl CameraBuffers {
    pub fn new() -> Self {
        Self {
            uyvy_buffer: Vec::new(),
            flip_buffer: Vec::new(),
        }
    }

    fn ensure_uyvy_capacity(&mut self, size: usize) -> &mut [u8] {
        if self.uyvy_buffer.len() < size {
            self.uyvy_buffer.resize(size, 0);
        }
        &mut self.uyvy_buffer[..size]
    }

    fn ensure_flip_capacity(&mut self, size: usize) -> &mut [u8] {
        if self.flip_buffer.len() < size {
            self.flip_buffer.resize(size, 0);
        }
        &mut self.flip_buffer[..size]
    }
}

impl Default for CameraBuffers {
    fn default() -> Self {
        Self::new()
    }
}

fn convert_uyvy_to_yuyv_into(src: &[u8], dst: &mut [u8], width: u32, height: u32) {
    let total_bytes = (width * height * 2) as usize;
    let src_len = src.len().min(total_bytes).min(dst.len());

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("ssse3") {
            unsafe {
                convert_uyvy_to_yuyv_ssse3(src, dst, src_len);
            }
            return;
        }
    }

    convert_uyvy_to_yuyv_scalar(src, dst, src_len);
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "ssse3")]
unsafe fn convert_uyvy_to_yuyv_ssse3(src: &[u8], dst: &mut [u8], len: usize) {
    use std::arch::x86_64::*;

    unsafe {
        let shuffle_mask = _mm_setr_epi8(1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14);

        let mut i = 0;
        let simd_end = len & !15;

        while i < simd_end {
            let chunk = _mm_loadu_si128(src.as_ptr().add(i) as *const __m128i);
            let shuffled = _mm_shuffle_epi8(chunk, shuffle_mask);
            _mm_storeu_si128(dst.as_mut_ptr().add(i) as *mut __m128i, shuffled);
            i += 16;
        }

        convert_uyvy_to_yuyv_scalar(&src[i..], &mut dst[i..], len - i);
    }
}

fn convert_uyvy_to_yuyv_scalar(src: &[u8], dst: &mut [u8], len: usize) {
    for i in (0..len).step_by(4) {
        if i + 3 < src.len() && i + 3 < dst.len() {
            dst[i] = src[i + 1];
            dst[i + 1] = src[i];
            dst[i + 2] = src[i + 3];
            dst[i + 3] = src[i + 2];
        }
    }
}

fn convert_uyvy_to_yuyv(src: &[u8], width: u32, height: u32) -> Vec<u8> {
    let total_bytes = (width * height * 2) as usize;
    let mut dst = vec![0u8; total_bytes];
    convert_uyvy_to_yuyv_into(src, &mut dst, width, height);
    dst
}

pub fn camera_frame_to_ffmpeg(frame: &NativeCameraFrame) -> anyhow::Result<ffmpeg::frame::Video> {
    use cap_mediafoundation_utils::IMFMediaBufferExt;

    if frame.pixel_format == cap_camera_windows::PixelFormat::MJPEG {
        return decode_mjpeg_frame(frame);
    }

    let ffmpeg_format = match frame.pixel_format {
        cap_camera_windows::PixelFormat::NV12 => ffmpeg::format::Pixel::NV12,
        cap_camera_windows::PixelFormat::YUYV422 => ffmpeg::format::Pixel::YUYV422,
        cap_camera_windows::PixelFormat::UYVY422 => ffmpeg::format::Pixel::UYVY422,
        cap_camera_windows::PixelFormat::ARGB | cap_camera_windows::PixelFormat::RGB32 => {
            ffmpeg::format::Pixel::BGRA
        }
        cap_camera_windows::PixelFormat::RGB24 => ffmpeg::format::Pixel::BGR24,
        cap_camera_windows::PixelFormat::BGR24 => ffmpeg::format::Pixel::BGR24,
        cap_camera_windows::PixelFormat::YUV420P => ffmpeg::format::Pixel::YUV420P,
        cap_camera_windows::PixelFormat::YV12 => ffmpeg::format::Pixel::YUV420P,
        cap_camera_windows::PixelFormat::NV21 => ffmpeg::format::Pixel::NV12,
        other => anyhow::bail!("Unsupported camera pixel format: {:?}", other),
    };

    let buffer_guard = frame
        .buffer
        .lock()
        .map_err(|_| anyhow!("Failed to lock camera buffer"))?;
    let lock = buffer_guard
        .lock()
        .map_err(|e| anyhow!("Failed to lock MF buffer: {:?}", e))?;
    let data = &*lock;

    let converted_data_storage;
    let (final_data, final_format): (&[u8], ffmpeg::format::Pixel) =
        if frame.pixel_format == cap_camera_windows::PixelFormat::UYVY422 {
            converted_data_storage = convert_uyvy_to_yuyv(data, frame.width, frame.height);
            (
                converted_data_storage.as_slice(),
                ffmpeg::format::Pixel::YUYV422,
            )
        } else {
            (data, ffmpeg_format)
        };

    let mut ffmpeg_frame = ffmpeg::frame::Video::new(final_format, frame.width, frame.height);
    let flip = frame.is_bottom_up;
    let width = frame.width as usize;
    let height = frame.height as usize;

    match frame.pixel_format {
        cap_camera_windows::PixelFormat::NV12 => {
            let y_size = width * height;
            let uv_size = y_size / 2;
            if final_data.len() >= y_size + uv_size {
                let stride_y = ffmpeg_frame.stride(0);
                let stride_uv = ffmpeg_frame.stride(1);
                copy_plane(
                    &final_data[..y_size],
                    ffmpeg_frame.data_mut(0),
                    width,
                    height,
                    stride_y,
                    flip,
                );
                copy_plane(
                    &final_data[y_size..y_size + uv_size],
                    ffmpeg_frame.data_mut(1),
                    width,
                    height / 2,
                    stride_uv,
                    flip,
                );
            }
        }
        cap_camera_windows::PixelFormat::NV21 => {
            let y_size = width * height;
            let uv_size = y_size / 2;
            if final_data.len() >= y_size + uv_size {
                let stride_y = ffmpeg_frame.stride(0);
                let stride_uv = ffmpeg_frame.stride(1);
                copy_plane(
                    &final_data[..y_size],
                    ffmpeg_frame.data_mut(0),
                    width,
                    height,
                    stride_y,
                    flip,
                );
                let uv_data = &final_data[y_size..y_size + uv_size];
                let uv_height = height / 2;
                let dest = ffmpeg_frame.data_mut(1);
                for row in 0..uv_height {
                    let src_row = if flip { uv_height - 1 - row } else { row };
                    for x in 0..width / 2 {
                        let src_idx = src_row * width + x * 2;
                        let dst_idx = row * stride_uv + x * 2;
                        if src_idx + 1 < uv_data.len() && dst_idx + 1 < dest.len() {
                            dest[dst_idx] = uv_data[src_idx + 1];
                            dest[dst_idx + 1] = uv_data[src_idx];
                        }
                    }
                }
            }
        }
        cap_camera_windows::PixelFormat::YUYV422 | cap_camera_windows::PixelFormat::UYVY422 => {
            let row_bytes = width * 2;
            let size = row_bytes * height;
            if final_data.len() >= size {
                let stride = ffmpeg_frame.stride(0);
                copy_plane(
                    final_data,
                    ffmpeg_frame.data_mut(0),
                    row_bytes,
                    height,
                    stride,
                    flip,
                );
            }
        }
        cap_camera_windows::PixelFormat::ARGB | cap_camera_windows::PixelFormat::RGB32 => {
            let row_bytes = width * 4;
            let size = row_bytes * height;
            if final_data.len() >= size {
                let stride = ffmpeg_frame.stride(0);
                copy_plane(
                    final_data,
                    ffmpeg_frame.data_mut(0),
                    row_bytes,
                    height,
                    stride,
                    flip,
                );
            }
        }
        cap_camera_windows::PixelFormat::RGB24 | cap_camera_windows::PixelFormat::BGR24 => {
            let row_bytes = width * 3;
            let size = row_bytes * height;
            if final_data.len() >= size {
                let stride = ffmpeg_frame.stride(0);
                copy_plane(
                    final_data,
                    ffmpeg_frame.data_mut(0),
                    row_bytes,
                    height,
                    stride,
                    flip,
                );
            }
        }
        cap_camera_windows::PixelFormat::YUV420P => {
            let y_size = width * height;
            let uv_size = y_size / 4;
            if final_data.len() >= y_size + uv_size * 2 {
                let stride_y = ffmpeg_frame.stride(0);
                let stride_u = ffmpeg_frame.stride(1);
                let stride_v = ffmpeg_frame.stride(2);
                copy_plane(
                    &final_data[..y_size],
                    ffmpeg_frame.data_mut(0),
                    width,
                    height,
                    stride_y,
                    flip,
                );
                copy_plane(
                    &final_data[y_size..y_size + uv_size],
                    ffmpeg_frame.data_mut(1),
                    width / 2,
                    height / 2,
                    stride_u,
                    flip,
                );
                copy_plane(
                    &final_data[y_size + uv_size..],
                    ffmpeg_frame.data_mut(2),
                    width / 2,
                    height / 2,
                    stride_v,
                    flip,
                );
            }
        }
        cap_camera_windows::PixelFormat::YV12 => {
            let y_size = width * height;
            let uv_size = y_size / 4;
            if final_data.len() >= y_size + uv_size * 2 {
                let stride_y = ffmpeg_frame.stride(0);
                let stride_u = ffmpeg_frame.stride(1);
                let stride_v = ffmpeg_frame.stride(2);
                copy_plane(
                    &final_data[..y_size],
                    ffmpeg_frame.data_mut(0),
                    width,
                    height,
                    stride_y,
                    flip,
                );
                copy_plane(
                    &final_data[y_size + uv_size..],
                    ffmpeg_frame.data_mut(1),
                    width / 2,
                    height / 2,
                    stride_u,
                    flip,
                );
                copy_plane(
                    &final_data[y_size..y_size + uv_size],
                    ffmpeg_frame.data_mut(2),
                    width / 2,
                    height / 2,
                    stride_v,
                    flip,
                );
            }
        }
        _ => {}
    }

    Ok(ffmpeg_frame)
}

fn copy_plane(src: &[u8], dst: &mut [u8], width: usize, height: usize, stride: usize, flip: bool) {
    for row in 0..height {
        let src_row = if flip { height - 1 - row } else { row };
        let src_start = src_row * width;
        let dst_start = row * stride;
        let copy_len = width.min(src.len().saturating_sub(src_start));
        if copy_len > 0 && dst_start + copy_len <= dst.len() {
            dst[dst_start..dst_start + copy_len]
                .copy_from_slice(&src[src_start..src_start + copy_len]);
        }
    }
}

fn decode_mjpeg_frame(frame: &NativeCameraFrame) -> anyhow::Result<ffmpeg::frame::Video> {
    use cap_mediafoundation_utils::IMFMediaBufferExt;

    let buffer_guard = frame
        .buffer
        .lock()
        .map_err(|_| anyhow!("Failed to lock camera buffer"))?;
    let lock = buffer_guard
        .lock()
        .map_err(|e| anyhow!("Failed to lock MF buffer: {:?}", e))?;
    let data = &*lock;

    let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::MJPEG)
        .ok_or_else(|| anyhow!("MJPEG codec not found"))?;

    let decoder_context = ffmpeg::codec::context::Context::new_with_codec(codec);
    let mut decoder = decoder_context
        .decoder()
        .video()
        .map_err(|e| anyhow!("Failed to create MJPEG decoder: {e}"))?;

    let packet = ffmpeg::Packet::copy(data);
    decoder
        .send_packet(&packet)
        .map_err(|e| anyhow!("Failed to send MJPEG packet: {e}"))?;

    let mut decoded_frame = ffmpeg::frame::Video::empty();
    decoder
        .receive_frame(&mut decoded_frame)
        .map_err(|e| anyhow!("Failed to decode MJPEG frame: {e}"))?;

    Ok(decoded_frame)
}

fn flip_buffer_size(
    width: usize,
    height: usize,
    pixel_format: cap_camera_windows::PixelFormat,
) -> usize {
    use cap_camera_windows::PixelFormat;

    match pixel_format {
        PixelFormat::NV12 | PixelFormat::NV21 => {
            let y_size = width * height;
            let uv_size = y_size / 2;
            y_size + uv_size
        }
        PixelFormat::YUV420P | PixelFormat::YV12 => {
            let y_size = width * height;
            let uv_plane_size = (width / 2) * (height / 2);
            y_size + uv_plane_size * 2
        }
        PixelFormat::P010 => {
            let y_size = width * height * 2;
            let uv_size = width * (height / 2) * 2;
            y_size + uv_size
        }
        PixelFormat::YUYV422 | PixelFormat::UYVY422 | PixelFormat::GRAY16 | PixelFormat::RGB565 => {
            width * 2 * height
        }
        PixelFormat::ARGB | PixelFormat::RGB32 => width * 4 * height,
        PixelFormat::RGB24 | PixelFormat::BGR24 => width * 3 * height,
        PixelFormat::GRAY8 => width * height,
        PixelFormat::MJPEG | PixelFormat::H264 => 0,
    }
}

fn flip_rows_into(data: &[u8], dst: &mut [u8], row_size: usize, height: usize) {
    for row in 0..height {
        let src_row = height - 1 - row;
        let src_start = src_row * row_size;
        let dst_start = row * row_size;
        if src_start + row_size <= data.len() && dst_start + row_size <= dst.len() {
            dst[dst_start..dst_start + row_size]
                .copy_from_slice(&data[src_start..src_start + row_size]);
        }
    }
}

fn flip_camera_buffer_into(
    data: &[u8],
    dst: &mut [u8],
    width: usize,
    height: usize,
    pixel_format: cap_camera_windows::PixelFormat,
) {
    use cap_camera_windows::PixelFormat;

    match pixel_format {
        PixelFormat::NV12 | PixelFormat::NV21 => {
            let y_size = width * height;

            flip_rows_into(data, dst, width, height);

            let uv_height = height / 2;
            let uv_row_size = width;
            for row in 0..uv_height {
                let src_row = uv_height - 1 - row;
                let src_start = y_size + src_row * uv_row_size;
                let dst_start = y_size + row * uv_row_size;
                if src_start + uv_row_size <= data.len() && dst_start + uv_row_size <= dst.len() {
                    dst[dst_start..dst_start + uv_row_size]
                        .copy_from_slice(&data[src_start..src_start + uv_row_size]);
                }
            }
        }
        PixelFormat::YUV420P | PixelFormat::YV12 => {
            let y_size = width * height;
            let uv_width = width / 2;
            let uv_height = height / 2;
            let uv_plane_size = uv_width * uv_height;

            flip_rows_into(data, dst, width, height);

            let u_offset = y_size;
            let v_offset = y_size + uv_plane_size;
            for row in 0..uv_height {
                let src_row = uv_height - 1 - row;
                let src_u_start = u_offset + src_row * uv_width;
                let dst_u_start = u_offset + row * uv_width;
                if src_u_start + uv_width <= data.len() && dst_u_start + uv_width <= dst.len() {
                    dst[dst_u_start..dst_u_start + uv_width]
                        .copy_from_slice(&data[src_u_start..src_u_start + uv_width]);
                }
                let src_v_start = v_offset + src_row * uv_width;
                let dst_v_start = v_offset + row * uv_width;
                if src_v_start + uv_width <= data.len() && dst_v_start + uv_width <= dst.len() {
                    dst[dst_v_start..dst_v_start + uv_width]
                        .copy_from_slice(&data[src_v_start..src_v_start + uv_width]);
                }
            }
        }
        PixelFormat::P010 => {
            let y_size = width * height * 2;
            let y_row_size = width * 2;

            flip_rows_into(data, dst, y_row_size, height);

            let uv_height = height / 2;
            let uv_row_size = width * 2;
            for row in 0..uv_height {
                let src_row = uv_height - 1 - row;
                let src_start = y_size + src_row * uv_row_size;
                let dst_start = y_size + row * uv_row_size;
                if src_start + uv_row_size <= data.len() && dst_start + uv_row_size <= dst.len() {
                    dst[dst_start..dst_start + uv_row_size]
                        .copy_from_slice(&data[src_start..src_start + uv_row_size]);
                }
            }
        }
        PixelFormat::YUYV422 | PixelFormat::UYVY422 | PixelFormat::GRAY16 | PixelFormat::RGB565 => {
            flip_rows_into(data, dst, width * 2, height);
        }
        PixelFormat::ARGB | PixelFormat::RGB32 => {
            flip_rows_into(data, dst, width * 4, height);
        }
        PixelFormat::RGB24 | PixelFormat::BGR24 => {
            flip_rows_into(data, dst, width * 3, height);
        }
        PixelFormat::GRAY8 => {
            flip_rows_into(data, dst, width, height);
        }
        PixelFormat::MJPEG | PixelFormat::H264 => {
            let copy_len = data.len().min(dst.len());
            dst[..copy_len].copy_from_slice(&data[..copy_len]);
        }
    }
}

pub fn upload_mf_buffer_to_texture(
    device: &ID3D11Device,
    frame: &NativeCameraFrame,
    buffers: &mut CameraBuffers,
) -> windows::core::Result<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D> {
    use cap_mediafoundation_utils::IMFMediaBufferExt;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;

    let dxgi_format = frame.dxgi_format();
    let bytes_per_pixel: u32 = match frame.pixel_format {
        cap_camera_windows::PixelFormat::NV12 => 1,
        cap_camera_windows::PixelFormat::YUYV422 | cap_camera_windows::PixelFormat::UYVY422 => 2,
        cap_camera_windows::PixelFormat::ARGB | cap_camera_windows::PixelFormat::RGB32 => 4,
        cap_camera_windows::PixelFormat::RGB24 => 3,
        _ => 2,
    };

    let buffer_guard = frame
        .buffer
        .lock()
        .map_err(|_| windows::core::Error::from(windows::core::HRESULT(-1)))?;
    let lock = buffer_guard.lock()?;
    let original_data = &*lock;

    let needs_uyvy_conversion = frame.pixel_format == cap_camera_windows::PixelFormat::UYVY422;
    let needs_flip = frame.is_bottom_up;

    let data: &[u8] = match (needs_uyvy_conversion, needs_flip) {
        (false, false) => original_data,
        (true, false) => {
            let uyvy_size = (frame.width * frame.height * 2) as usize;
            let dst = buffers.ensure_uyvy_capacity(uyvy_size);
            convert_uyvy_to_yuyv_into(original_data, dst, frame.width, frame.height);
            dst
        }
        (false, true) => {
            let flip_size = flip_buffer_size(
                frame.width as usize,
                frame.height as usize,
                frame.pixel_format,
            );
            let dst = buffers.ensure_flip_capacity(flip_size);
            flip_camera_buffer_into(
                original_data,
                dst,
                frame.width as usize,
                frame.height as usize,
                frame.pixel_format,
            );
            dst
        }
        (true, true) => {
            let uyvy_size = (frame.width * frame.height * 2) as usize;
            let flip_size = flip_buffer_size(
                frame.width as usize,
                frame.height as usize,
                frame.pixel_format,
            );

            if buffers.uyvy_buffer.len() < uyvy_size {
                buffers.uyvy_buffer.resize(uyvy_size, 0);
            }
            if buffers.flip_buffer.len() < flip_size {
                buffers.flip_buffer.resize(flip_size, 0);
            }

            convert_uyvy_to_yuyv_into(
                original_data,
                &mut buffers.uyvy_buffer[..uyvy_size],
                frame.width,
                frame.height,
            );

            flip_camera_buffer_into(
                &buffers.uyvy_buffer[..uyvy_size],
                &mut buffers.flip_buffer[..flip_size],
                frame.width as usize,
                frame.height as usize,
                frame.pixel_format,
            );
            &buffers.flip_buffer[..flip_size]
        }
    };

    let row_pitch = frame.width * bytes_per_pixel;

    let texture_desc = D3D11_TEXTURE2D_DESC {
        Width: frame.width,
        Height: frame.height,
        MipLevels: 1,
        ArraySize: 1,
        Format: dxgi_format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let subresource_data = D3D11_SUBRESOURCE_DATA {
        pSysMem: data.as_ptr() as *const _,
        SysMemPitch: row_pitch,
        SysMemSlicePitch: 0,
    };

    unsafe {
        let mut texture = None;
        device.CreateTexture2D(&texture_desc, Some(&subresource_data), Some(&mut texture))?;
        texture.ok_or_else(|| anyhow!("CreateTexture2D succeeded but returned no texture"))
    }
}
