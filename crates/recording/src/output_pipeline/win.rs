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
        mpsc::{SyncSender, sync_channel},
    },
    time::Duration,
};
use tracing::*;
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

struct PauseTracker {
    flag: Arc<AtomicBool>,
    paused_at: Option<Duration>,
    offset: Duration,
}

impl PauseTracker {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            paused_at: None,
            offset: Duration::ZERO,
        }
    }

    fn adjust(&mut self, timestamp: Duration) -> anyhow::Result<Option<Duration>> {
        if self.flag.load(Ordering::Acquire) {
            if self.paused_at.is_none() {
                self.paused_at = Some(timestamp);
            }
            return Ok(None);
        }

        if let Some(start) = self.paused_at.take() {
            let delta = match timestamp.checked_sub(start) {
                Some(d) => d,
                None => {
                    warn!(
                        resume_at = ?start,
                        current = ?timestamp,
                        "Timestamp anomaly: frame timestamp went backward during unpause (clock skew?), treating as zero delta"
                    );
                    Duration::ZERO
                }
            };

            self.offset = match self.offset.checked_add(delta) {
                Some(o) => o,
                None => {
                    warn!(
                        offset = ?self.offset,
                        delta = ?delta,
                        "Timestamp anomaly: pause offset overflow, clamping to MAX"
                    );
                    Duration::MAX
                }
            };
        }

        let adjusted = match timestamp.checked_sub(self.offset) {
            Some(t) => t,
            None => {
                warn!(
                    timestamp = ?timestamp,
                    offset = ?self.offset,
                    "Timestamp anomaly: adjusted timestamp underflow (clock skew?), using zero"
                );
                Duration::ZERO
            }
        };

        Ok(Some(adjusted))
    }
}

pub struct WindowsMuxer {
    video_tx: SyncSender<Option<(scap_direct3d::Frame, Duration)>>,
    output: Arc<Mutex<ffmpeg::format::context::Output>>,
    audio_encoder: Option<AACEncoder>,
    pause: PauseTracker,
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
        let queue_depth = ((config.frame_rate as f32 / 30.0 * 5.0).ceil() as usize).clamp(3, 12);
        let (video_tx, video_rx) =
            sync_channel::<Option<(scap_direct3d::Frame, Duration)>>(queue_depth);

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

                match encoder {
                    either::Left((mut encoder, mut muxer)) => {
                        trace!("Running native encoder");
                        let mut first_timestamp: Option<Duration> = None;
                        let result = encoder.run(
                            Arc::new(AtomicBool::default()),
                            || {
                                let Ok(Some((frame, timestamp))) = video_rx.recv() else {
                                    trace!("No more frames available");
                                    return Ok(None);
                                };

                                let relative = if let Some(first) = first_timestamp {
                                    timestamp.saturating_sub(first)
                                } else {
                                    first_timestamp = Some(timestamp);
                                    Duration::ZERO
                                };
                                let frame_time = duration_to_timespan(relative);

                                Ok(Some((frame.texture().clone(), frame_time)))
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
                        while let Ok(Some((frame, time))) = video_rx.recv() {
                            let Ok(mut output) = output.lock() else {
                                continue;
                            };

                            use scap_ffmpeg::AsFFmpeg;

                            frame
                                .as_ffmpeg()
                                .context("frame as_ffmpeg")
                                .and_then(|frame| {
                                    encoder
                                        .queue_frame(frame, time, &mut output)
                                        .context("queue_frame")
                                })?;
                        }

                        Ok(())
                    }
                }
            });
        }

        ready_rx
            .await
            .map_err(|_| anyhow!("Encoder thread ended unexpectedly"))??;

        output.lock().unwrap().write_header()?;

        Ok(Self {
            video_tx,
            output,
            audio_encoder,
            pause: PauseTracker::new(pause_flag),
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
        if let Some(timestamp) = self.pause.adjust(timestamp)? {
            self.video_tx.send(Some((frame.frame, timestamp)))?;
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(timestamp) = self.pause.adjust(timestamp)?
            && let Some(encoder) = self.audio_encoder.as_mut()
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
    pause: PauseTracker,
}

pub struct WindowsCameraMuxerConfig {
    pub output_height: Option<u32>,
    pub fragmented: bool,
    pub frag_duration_us: i64,
    pub encoder_preferences: crate::capture_pipeline::EncoderPreferences,
}

impl Default for WindowsCameraMuxerConfig {
    fn default() -> Self {
        Self {
            output_height: None,
            fragmented: false,
            frag_duration_us: 2_000_000,
            encoder_preferences: crate::capture_pipeline::EncoderPreferences::new(),
        }
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

        let (video_tx, video_rx) = sync_channel::<Option<(NativeCameraFrame, Duration)>>(30);

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

                let first_frame = match video_rx.recv() {
                    Ok(Some(frame)) => frame,
                    Ok(None) => {
                        let _ = ready_tx.send(Ok(()));
                        return Ok(());
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(anyhow!("No frames received: {e}")));
                        return Err(anyhow!("No frames received: {e}"));
                    }
                };

                let input_format = first_frame.0.dxgi_format();

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

                match encoder {
                    either::Left((mut encoder, mut muxer)) => {
                        info!(
                            "Windows camera encoder started (hardware): {:?} {}x{} -> NV12 {}x{} @ {}fps",
                            input_format,
                            input_size.Width,
                            input_size.Height,
                            output_size.Width,
                            output_size.Height,
                            frame_rate
                        );

                        let mut first_timestamp: Option<Duration> = None;
                        let mut frame_count = 0u64;

                        let mut process_frame = |frame: NativeCameraFrame,
                                                 timestamp: Duration|
                         -> windows::core::Result<
                            Option<(
                                windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
                                TimeSpan,
                            )>,
                        > {
                            let relative = if let Some(first) = first_timestamp {
                                timestamp.saturating_sub(first)
                            } else {
                                first_timestamp = Some(timestamp);
                                Duration::ZERO
                            };

                            let texture = upload_mf_buffer_to_texture(&d3d_device, &frame)?;
                            Ok(Some((texture, duration_to_timespan(relative))))
                        };

                        if let Ok(Some((texture, frame_time))) =
                            process_frame(first_frame.0, first_frame.1)
                        {
                            let result = encoder.run(
                                Arc::new(AtomicBool::default()),
                                || {
                                    if frame_count > 0 {
                                        let Ok(Some((frame, timestamp))) = video_rx.recv() else {
                                            trace!("No more camera frames available");
                                            return Ok(None);
                                        };
                                        frame_count += 1;
                                        if frame_count.is_multiple_of(30) {
                                            debug!(
                                                "Windows camera encoder: processed {} frames",
                                                frame_count
                                            );
                                        }
                                        return process_frame(frame, timestamp);
                                    }
                                    frame_count += 1;
                                    Ok(Some((texture.clone(), frame_time)))
                                },
                                |output_sample| {
                                    let mut output = output.lock().unwrap();
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
                        }

                        Ok(())
                    }
                    either::Right(mut encoder) => {
                        info!(
                            "Windows camera encoder started (software): {}x{} -> {}x{} @ {}fps",
                            video_config.width,
                            video_config.height,
                            output_width,
                            output_height,
                            frame_rate
                        );

                        let mut first_timestamp: Option<Duration> = None;
                        let mut frame_count = 0u64;

                        let mut process_frame =
                            |frame: NativeCameraFrame,
                             timestamp: Duration|
                             -> anyhow::Result<Option<Duration>> {
                                let relative = if let Some(first) = first_timestamp {
                                    timestamp.saturating_sub(first)
                                } else {
                                    first_timestamp = Some(timestamp);
                                    Duration::ZERO
                                };

                                let ffmpeg_frame = camera_frame_to_ffmpeg(&frame)?;

                                let Ok(mut output_guard) = output.lock() else {
                                    return Ok(None);
                                };

                                encoder
                                    .queue_frame(ffmpeg_frame, relative, &mut output_guard)
                                    .context("queue camera frame")?;

                                Ok(Some(relative))
                            };

                        if process_frame(first_frame.0, first_frame.1)?.is_some() {
                            frame_count += 1;
                        }

                        while let Ok(Some((frame, timestamp))) = video_rx.recv() {
                            if process_frame(frame, timestamp)?.is_some() {
                                frame_count += 1;
                                if frame_count.is_multiple_of(30) {
                                    debug!(
                                        "Windows camera encoder (software): processed {} frames",
                                        frame_count
                                    );
                                }
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

        output.lock().unwrap().write_header()?;

        Ok(Self {
            video_tx,
            output,
            audio_encoder,
            pause: PauseTracker::new(pause_flag),
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
        if let Some(timestamp) = self.pause.adjust(timestamp)? {
            self.video_tx
                .send(Some((frame, timestamp)))
                .map_err(|_| anyhow!("Video channel closed"))?;
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsCameraMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(timestamp) = self.pause.adjust(timestamp)?
            && let Some(encoder) = self.audio_encoder.as_mut()
            && let Ok(mut output) = self.output.lock()
        {
            encoder.send_frame(frame.inner, timestamp, &mut output)?;
        }

        Ok(())
    }
}

fn convert_uyvy_to_yuyv(src: &[u8], width: u32, height: u32) -> Vec<u8> {
    let total_bytes = (width * height * 2) as usize;
    let src_len = src.len().min(total_bytes);
    let mut dst = vec![0u8; total_bytes];

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("ssse3") {
            unsafe {
                convert_uyvy_to_yuyv_ssse3(src, &mut dst, src_len);
            }
            return dst;
        }
    }

    convert_uyvy_to_yuyv_scalar(src, &mut dst, src_len);
    dst
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

    match frame.pixel_format {
        cap_camera_windows::PixelFormat::NV12 => {
            let y_size = (frame.width * frame.height) as usize;
            let uv_size = y_size / 2;
            if final_data.len() >= y_size + uv_size {
                ffmpeg_frame.data_mut(0)[..y_size].copy_from_slice(&final_data[..y_size]);
                ffmpeg_frame.data_mut(1)[..uv_size].copy_from_slice(&final_data[y_size..]);
            }
        }
        cap_camera_windows::PixelFormat::NV21 => {
            let y_size = (frame.width * frame.height) as usize;
            let uv_size = y_size / 2;
            if final_data.len() >= y_size + uv_size {
                ffmpeg_frame.data_mut(0)[..y_size].copy_from_slice(&final_data[..y_size]);
                let uv_data = &final_data[y_size..y_size + uv_size];
                let dest = ffmpeg_frame.data_mut(1);
                for i in (0..uv_size).step_by(2) {
                    if i + 1 < uv_data.len() && i + 1 < dest.len() {
                        dest[i] = uv_data[i + 1];
                        dest[i + 1] = uv_data[i];
                    }
                }
            }
        }
        cap_camera_windows::PixelFormat::YUYV422 | cap_camera_windows::PixelFormat::UYVY422 => {
            let size = (frame.width * frame.height * 2) as usize;
            if final_data.len() >= size {
                ffmpeg_frame.data_mut(0)[..size].copy_from_slice(&final_data[..size]);
            }
        }
        cap_camera_windows::PixelFormat::ARGB | cap_camera_windows::PixelFormat::RGB32 => {
            let size = (frame.width * frame.height * 4) as usize;
            if final_data.len() >= size {
                ffmpeg_frame.data_mut(0)[..size].copy_from_slice(&final_data[..size]);
            }
        }
        cap_camera_windows::PixelFormat::RGB24 | cap_camera_windows::PixelFormat::BGR24 => {
            let size = (frame.width * frame.height * 3) as usize;
            if final_data.len() >= size {
                ffmpeg_frame.data_mut(0)[..size].copy_from_slice(&final_data[..size]);
            }
        }
        cap_camera_windows::PixelFormat::YUV420P => {
            let y_size = (frame.width * frame.height) as usize;
            let uv_size = y_size / 4;
            if final_data.len() >= y_size + uv_size * 2 {
                let stride_y = ffmpeg_frame.stride(0);
                let stride_u = ffmpeg_frame.stride(1);
                let stride_v = ffmpeg_frame.stride(2);
                copy_plane(
                    &final_data[..y_size],
                    ffmpeg_frame.data_mut(0),
                    frame.width as usize,
                    frame.height as usize,
                    stride_y,
                );
                copy_plane(
                    &final_data[y_size..y_size + uv_size],
                    ffmpeg_frame.data_mut(1),
                    (frame.width / 2) as usize,
                    (frame.height / 2) as usize,
                    stride_u,
                );
                copy_plane(
                    &final_data[y_size + uv_size..],
                    ffmpeg_frame.data_mut(2),
                    (frame.width / 2) as usize,
                    (frame.height / 2) as usize,
                    stride_v,
                );
            }
        }
        cap_camera_windows::PixelFormat::YV12 => {
            let y_size = (frame.width * frame.height) as usize;
            let uv_size = y_size / 4;
            if final_data.len() >= y_size + uv_size * 2 {
                let stride_y = ffmpeg_frame.stride(0);
                let stride_u = ffmpeg_frame.stride(1);
                let stride_v = ffmpeg_frame.stride(2);
                copy_plane(
                    &final_data[..y_size],
                    ffmpeg_frame.data_mut(0),
                    frame.width as usize,
                    frame.height as usize,
                    stride_y,
                );
                copy_plane(
                    &final_data[y_size + uv_size..],
                    ffmpeg_frame.data_mut(1),
                    (frame.width / 2) as usize,
                    (frame.height / 2) as usize,
                    stride_u,
                );
                copy_plane(
                    &final_data[y_size..y_size + uv_size],
                    ffmpeg_frame.data_mut(2),
                    (frame.width / 2) as usize,
                    (frame.height / 2) as usize,
                    stride_v,
                );
            }
        }
        _ => {}
    }

    Ok(ffmpeg_frame)
}

fn copy_plane(src: &[u8], dst: &mut [u8], width: usize, height: usize, stride: usize) {
    for row in 0..height {
        let src_start = row * width;
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

pub fn upload_mf_buffer_to_texture(
    device: &ID3D11Device,
    frame: &NativeCameraFrame,
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

    let converted_buffer_storage;
    let data: &[u8] = if frame.pixel_format == cap_camera_windows::PixelFormat::UYVY422 {
        converted_buffer_storage = convert_uyvy_to_yuyv(original_data, frame.width, frame.height);
        converted_buffer_storage.as_slice()
    } else {
        original_data
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
        Ok(texture.unwrap())
    }
}
