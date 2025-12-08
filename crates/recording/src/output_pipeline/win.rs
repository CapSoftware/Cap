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
        Dxgi::Common::{DXGI_FORMAT, DXGI_FORMAT_NV12, DXGI_FORMAT_YUY2},
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
        if self.flag.load(Ordering::Relaxed) {
            if self.paused_at.is_none() {
                self.paused_at = Some(timestamp);
            }
            return Ok(None);
        }

        if let Some(start) = self.paused_at.take() {
            let delta = timestamp.checked_sub(start).ok_or_else(|| {
                anyhow!(
                    "Frame timestamp went backward during unpause (resume={start:?}, current={timestamp:?})"
                )
            })?;

            self.offset = self.offset.checked_add(delta).ok_or_else(|| {
                anyhow!(
                    "Pause offset overflow (offset={:?}, delta={delta:?})",
                    self.offset
                )
            })?;
        }

        let adjusted = timestamp.checked_sub(self.offset).ok_or_else(|| {
            anyhow!(
                "Adjusted timestamp underflow (timestamp={timestamp:?}, offset={:?})",
                self.offset
            )
        })?;

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
        let (video_tx, video_rx) = sync_channel::<Option<(scap_direct3d::Frame, Duration)>>(8);

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
                            .and_then(|builder| builder.build(&mut *output_guard))
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
                                            "Failed to lock output mutex: {}",
                                            poisoned
                                        )));
                                    }
                                };

                                cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                                    &mut *output_guard,
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
                        encoder
                            .run(
                                Arc::new(AtomicBool::default()),
                                || {
                                    let Ok(Some((frame, timestamp))) = video_rx.recv() else {
                                        trace!("No more frames available");
                                        return Ok(None);
                                    };

                                    let relative = if let Some(first) = first_timestamp {
                                        timestamp.checked_sub(first).unwrap_or(Duration::ZERO)
                                    } else {
                                        first_timestamp = Some(timestamp);
                                        Duration::ZERO
                                    };
                                    let frame_time = duration_to_timespan(relative);

                                    Ok(Some((frame.texture().clone(), frame_time)))
                                },
                                |output_sample| {
                                    let mut output = output.lock().unwrap();

                                    let _ = muxer
                                        .write_sample(&output_sample, &mut *output)
                                        .map_err(|e| format!("WriteSample: {e}"));

                                    Ok(())
                                },
                            )
                            .context("run native encoder")
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
}

impl Default for WindowsCameraMuxerConfig {
    fn default() -> Self {
        Self {
            output_height: None,
            fragmented: false,
            frag_duration_us: 2_000_000,
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

                let encoder_result = cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                    &d3d_device,
                    input_format,
                    input_size,
                    output_size,
                    frame_rate,
                    bitrate_multiplier,
                );

                let (mut encoder, mut muxer) = match encoder_result {
                    Ok(encoder) => {
                        let muxer = {
                            let mut output_guard = match output.lock() {
                                Ok(guard) => guard,
                                Err(poisoned) => {
                                    let msg = format!("Failed to lock output mutex: {}", poisoned);
                                    let _ = ready_tx.send(Err(anyhow!("{}", msg)));
                                    return Err(anyhow!("{}", msg));
                                }
                            };

                            cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                                &mut *output_guard,
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
                            Ok(muxer) => (encoder, muxer),
                            Err(err) => {
                                let msg = format!("Failed to create muxer: {err}");
                                let _ = ready_tx.send(Err(anyhow!("{}", msg)));
                                return Err(anyhow!("{}", msg));
                            }
                        }
                    }
                    Err(err) => {
                        let msg = format!("Failed to create H264 encoder: {err}");
                        let _ = ready_tx.send(Err(anyhow!("{}", msg)));
                        return Err(anyhow!("{}", msg));
                    }
                };

                if ready_tx.send(Ok(())).is_err() {
                    error!("Failed to send ready signal - receiver dropped");
                    return Ok(());
                }

                info!(
                    "Windows camera encoder started: {:?} {}x{} -> NV12 {}x{} @ {}fps",
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
                        timestamp.checked_sub(first).unwrap_or(Duration::ZERO)
                    } else {
                        first_timestamp = Some(timestamp);
                        Duration::ZERO
                    };

                    let texture = upload_mf_buffer_to_texture(&d3d_device, &frame)?;
                    Ok(Some((texture, duration_to_timespan(relative))))
                };

                if let Ok(Some((texture, frame_time))) = process_frame(first_frame.0, first_frame.1)
                {
                    encoder
                        .run(
                            Arc::new(AtomicBool::default()),
                            || {
                                if frame_count > 0 {
                                    let Ok(Some((frame, timestamp))) = video_rx.recv() else {
                                        trace!("No more camera frames available");
                                        return Ok(None);
                                    };
                                    frame_count += 1;
                                    if frame_count % 30 == 0 {
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
                                let _ = muxer
                                    .write_sample(&output_sample, &mut *output)
                                    .map_err(|e| format!("WriteSample: {e}"));
                                Ok(())
                            },
                        )
                        .context("run camera encoder")?;
                }

                info!(
                    "Windows camera encoder finished: {} frames encoded",
                    frame_count
                );
                Ok(())
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

fn upload_mf_buffer_to_texture(
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
        _ => 2,
    };

    let buffer_guard = frame
        .buffer
        .lock()
        .map_err(|_| windows::core::Error::from(windows::core::HRESULT(-1)))?;
    let lock = buffer_guard.lock()?;
    let data = &*lock;

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
