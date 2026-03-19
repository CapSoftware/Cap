use crate::{
    AudioFrame, SetupCtx, output_pipeline,
    screen_capture::{ScreenCaptureConfig, ScreenCaptureFormat},
};
use ::windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Texture2D,
};
use ::windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use anyhow::anyhow;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{PerformanceCounterTimestamp, Timestamp};
use cpal::traits::{DeviceTrait, HostTrait};
use futures::{
    FutureExt, StreamExt,
    channel::{mpsc, oneshot},
};
use scap_ffmpeg::*;
use scap_targets::{Display, DisplayId};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{self, AtomicBool, AtomicU32},
    },
    time::Duration,
};
use tokio_util::{future::FutureExt as _, sync::CancellationToken};
use tracing::*;

// const WINDOW_DURATION: Duration = Duration::from_secs(3);
// const LOG_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct Direct3DCapture;

impl Direct3DCapture {
    pub const PIXEL_FORMAT: scap_direct3d::PixelFormat = scap_direct3d::PixelFormat::R8G8B8A8Unorm;
}

impl ScreenCaptureFormat for Direct3DCapture {
    type VideoFormat = scap_direct3d::Frame;

    fn pixel_format() -> ffmpeg::format::Pixel {
        scap_direct3d::PixelFormat::R8G8B8A8Unorm.as_ffmpeg()
    }

    fn audio_info() -> AudioInfo {
        let host = cpal::default_host();
        let Some(output_device) = host.default_output_device() else {
            warn!("No default audio output device available, using fallback audio config");
            return AudioInfo::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                48_000,
                2,
            )
            .expect("fallback audio config");
        };
        let Ok(supported_config) = output_device.default_output_config() else {
            warn!("Failed to get default output config, using fallback audio config");
            return AudioInfo::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                48_000,
                2,
            )
            .expect("fallback audio config");
        };

        let mut info = AudioInfo::from_stream_config(&supported_config);
        let sample_format = info.sample_format;
        info.sample_format = match sample_format {
            ffmpeg::format::Sample::U8(_) => {
                ffmpeg::format::Sample::U8(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::I16(_) => {
                ffmpeg::format::Sample::I16(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::I32(_) => {
                ffmpeg::format::Sample::I32(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::I64(_) => {
                ffmpeg::format::Sample::I64(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::F32(_) => {
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::F64(_) => {
                ffmpeg::format::Sample::F64(ffmpeg::format::sample::Type::Packed)
            }
            other => other,
        };

        info
    }
}

pub enum ScreenFrame {
    Captured(scap_direct3d::Frame),
    Scaled(ScaledScreenFrame),
}

pub struct ScaledScreenFrame {
    texture: ID3D11Texture2D,
    pixel_data: Vec<u8>,
    width: u32,
    height: u32,
    pixel_format: scap_direct3d::PixelFormat,
}

unsafe impl Send for ScaledScreenFrame {}

impl ScreenFrame {
    pub fn texture(&self) -> &ID3D11Texture2D {
        match self {
            ScreenFrame::Captured(frame) => frame.texture(),
            ScreenFrame::Scaled(scaled) => &scaled.texture,
        }
    }

    pub fn width(&self) -> u32 {
        match self {
            ScreenFrame::Captured(frame) => frame.width(),
            ScreenFrame::Scaled(scaled) => scaled.width,
        }
    }

    pub fn height(&self) -> u32 {
        match self {
            ScreenFrame::Captured(frame) => frame.height(),
            ScreenFrame::Scaled(scaled) => scaled.height,
        }
    }

    pub fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ::windows::core::Error> {
        match self {
            ScreenFrame::Captured(frame) => {
                use scap_ffmpeg::AsFFmpeg;
                frame.as_ffmpeg()
            }
            ScreenFrame::Scaled(scaled) => {
                let ffmpeg_pixel = match scaled.pixel_format {
                    scap_direct3d::PixelFormat::R8G8B8A8Unorm => ffmpeg::format::Pixel::RGBA,
                    scap_direct3d::PixelFormat::B8G8R8A8Unorm => ffmpeg::format::Pixel::BGRA,
                };
                let mut ff_frame =
                    ffmpeg::frame::Video::new(ffmpeg_pixel, scaled.width, scaled.height);
                let dest_stride = ff_frame.stride(0);
                let dest_bytes = ff_frame.data_mut(0);
                let row_length = (scaled.width * 4) as usize;

                for row in 0..scaled.height as usize {
                    let src_start = row * row_length;
                    let dst_start = row * dest_stride;
                    let copy_len = row_length.min(
                        scaled
                            .pixel_data
                            .len()
                            .saturating_sub(src_start)
                            .min(dest_bytes.len().saturating_sub(dst_start)),
                    );
                    if copy_len > 0 {
                        dest_bytes[dst_start..dst_start + copy_len]
                            .copy_from_slice(&scaled.pixel_data[src_start..src_start + copy_len]);
                    }
                }

                Ok(ff_frame)
            }
        }
    }
}

struct FrameScalerState {
    context: ffmpeg::software::scaling::Context,
    source_width: u32,
    source_height: u32,
}

unsafe impl Send for FrameScalerState {}

struct WindowsFrameScaler {
    target_width: u32,
    target_height: u32,
    pixel_format: scap_direct3d::PixelFormat,
    d3d_device: ID3D11Device,
    state: Option<FrameScalerState>,
}

impl WindowsFrameScaler {
    fn new(
        target_width: u32,
        target_height: u32,
        pixel_format: scap_direct3d::PixelFormat,
        d3d_device: ID3D11Device,
    ) -> Self {
        Self {
            target_width,
            target_height,
            pixel_format,
            d3d_device,
            state: None,
        }
    }

    fn scale_frame(&mut self, frame: &scap_direct3d::Frame) -> Option<ScreenFrame> {
        let src_width = frame.width();
        let src_height = frame.height();

        let needs_reinit = self
            .state
            .as_ref()
            .is_none_or(|s| s.source_width != src_width || s.source_height != src_height);

        if needs_reinit {
            let src_pixel = match self.pixel_format {
                scap_direct3d::PixelFormat::R8G8B8A8Unorm => ffmpeg::format::Pixel::RGBA,
                scap_direct3d::PixelFormat::B8G8R8A8Unorm => ffmpeg::format::Pixel::BGRA,
            };

            let context = ffmpeg::software::scaling::Context::get(
                src_pixel,
                src_width,
                src_height,
                src_pixel,
                self.target_width,
                self.target_height,
                ffmpeg::software::scaling::Flags::BILINEAR,
            )
            .ok()?;

            self.state = Some(FrameScalerState {
                context,
                source_width: src_width,
                source_height: src_height,
            });
        }

        let buffer = frame.as_buffer().ok()?;
        let src_data = buffer.data();
        let src_stride = buffer.stride() as usize;
        let row_length = (src_width * 4) as usize;

        let src_pixel = match self.pixel_format {
            scap_direct3d::PixelFormat::R8G8B8A8Unorm => ffmpeg::format::Pixel::RGBA,
            scap_direct3d::PixelFormat::B8G8R8A8Unorm => ffmpeg::format::Pixel::BGRA,
        };

        let mut src_frame = ffmpeg::frame::Video::new(src_pixel, src_width, src_height);
        let ff_stride = src_frame.stride(0);
        let ff_data = src_frame.data_mut(0);

        for row in 0..src_height as usize {
            let s_start = row * src_stride;
            let d_start = row * ff_stride;
            let copy_len = row_length.min(
                src_data
                    .len()
                    .saturating_sub(s_start)
                    .min(ff_data.len().saturating_sub(d_start)),
            );
            if copy_len > 0 {
                ff_data[d_start..d_start + copy_len]
                    .copy_from_slice(&src_data[s_start..s_start + copy_len]);
            }
        }

        drop(buffer);

        let state = self.state.as_mut()?;
        let mut dst_frame =
            ffmpeg::frame::Video::new(src_pixel, self.target_width, self.target_height);
        state.context.run(&src_frame, &mut dst_frame).ok()?;

        let dst_stride = dst_frame.stride(0);
        let dst_row_length = (self.target_width * 4) as usize;
        let total_bytes = dst_row_length * self.target_height as usize;
        let mut pixel_data = vec![0u8; total_bytes];
        let dst_data = dst_frame.data(0);

        for row in 0..self.target_height as usize {
            let s_start = row * dst_stride;
            let d_start = row * dst_row_length;
            let copy_len = dst_row_length.min(
                dst_data
                    .len()
                    .saturating_sub(s_start)
                    .min(pixel_data.len().saturating_sub(d_start)),
            );
            if copy_len > 0 {
                pixel_data[d_start..d_start + copy_len]
                    .copy_from_slice(&dst_data[s_start..s_start + copy_len]);
            }
        }

        let dxgi_format = match self.pixel_format {
            scap_direct3d::PixelFormat::R8G8B8A8Unorm => {
                ::windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R8G8B8A8_UNORM
            }
            scap_direct3d::PixelFormat::B8G8R8A8Unorm => {
                ::windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM
            }
        };

        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: self.target_width,
            Height: self.target_height,
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
            pSysMem: pixel_data.as_ptr() as *const _,
            SysMemPitch: dst_row_length as u32,
            SysMemSlicePitch: 0,
        };

        let texture = unsafe {
            let mut tex = None;
            self.d3d_device
                .CreateTexture2D(&texture_desc, Some(&subresource_data), Some(&mut tex))
                .ok()?;
            tex?
        };

        Some(ScreenFrame::Scaled(ScaledScreenFrame {
            texture,
            pixel_data,
            width: self.target_width,
            height: self.target_height,
            pixel_format: self.pixel_format,
        }))
    }
}

pub struct VideoFrame {
    pub frame: ScreenFrame,
    pub timestamp: Timestamp,
}

impl output_pipeline::VideoFrame for VideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

impl ScreenCaptureConfig<Direct3DCapture> {
    pub async fn to_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let mut settings = scap_direct3d::Settings {
            pixel_format: Direct3DCapture::PIXEL_FORMAT,
            crop: self.config.crop_bounds.map(|b| {
                let position = b.position();
                let size = b.size().map(|v| (v / 2.0).floor() * 2.0);

                let left = position.x().max(0.0) as u32;
                let top = position.y().max(0.0) as u32;
                let right = (position.x() + size.width()).max(0.0) as u32;
                let bottom = (position.y() + size.height()).max(0.0) as u32;

                D3D11_BOX {
                    left,
                    top,
                    right: right.max(left),
                    bottom: bottom.max(top),
                    front: 0,
                    back: 1,
                }
            }),
            ..Default::default()
        };

        if let Ok(true) = scap_direct3d::Settings::can_is_border_required() {
            settings.is_border_required = Some(false);
        }

        if let Ok(true) = scap_direct3d::Settings::can_is_cursor_capture_enabled() {
            settings.is_cursor_capture_enabled = Some(self.config.show_cursor);
        }

        if let Ok(true) = scap_direct3d::Settings::can_min_update_interval() {
            settings.min_update_interval =
                Some(Duration::from_secs_f64(1.0 / self.config.fps as f64));
        }

        settings.fps = Some(self.config.fps);

        // Store the display ID instead of GraphicsCaptureItem to avoid COM threading issues
        // The GraphicsCaptureItem will be created on the capture thread
        Ok((
            VideoSourceConfig {
                video_info: self.video_info,
                display_id: self.config.display.clone(),
                settings,
                d3d_device: self.d3d_device.clone(),
            },
            self.system_audio.then_some(SystemAudioSourceConfig),
        ))
    }
}

#[derive(thiserror::Error, Clone, Copy, Debug)]
pub enum VideoSourceError {
    #[error("Screen capture closed")]
    Closed,
}

pub struct VideoSourceConfig {
    video_info: VideoInfo,
    display_id: DisplayId,
    settings: scap_direct3d::Settings,
    pub d3d_device: ID3D11Device,
}
pub struct VideoSource {
    video_info: VideoInfo,
    ctrl_tx: std::sync::mpsc::SyncSender<VideoControl>,
}

enum VideoControl {
    Start(oneshot::Sender<anyhow::Result<()>>),
    Stop(oneshot::Sender<anyhow::Result<()>>),
    Restart,
}

const MAX_CAPTURE_RESTARTS: u32 = 3;
const RESTART_DELAY: Duration = Duration::from_secs(1);

struct CreateCapturerParams<'a> {
    display_id: &'a DisplayId,
    settings: &'a scap_direct3d::Settings,
    d3d_device: &'a ID3D11Device,
    video_tx: &'a mpsc::Sender<VideoFrame>,
    video_frame_counter: &'a Arc<AtomicU32>,
    video_drop_counter: &'a Arc<AtomicU32>,
    expected_width: u32,
    expected_height: u32,
    frame_scaler: Arc<Mutex<WindowsFrameScaler>>,
    scaling_logged: Arc<AtomicBool>,
    scaled_frame_count: Arc<AtomicU32>,
}

fn create_d3d_capturer(
    params: &CreateCapturerParams,
    error_tx: &mpsc::Sender<anyhow::Error>,
) -> anyhow::Result<scap_direct3d::Capturer> {
    let capture_item = Display::from_id(params.display_id)
        .ok_or_else(|| anyhow!("Display not found for ID: {:?}", params.display_id))?
        .raw_handle()
        .try_as_capture_item()
        .map_err(|e| anyhow!("Failed to create GraphicsCaptureItem: {}", e))?;

    scap_direct3d::Capturer::new(
        capture_item,
        params.settings.clone(),
        {
            let video_frame_counter = params.video_frame_counter.clone();
            let video_drop_counter = params.video_drop_counter.clone();
            let mut tx = params.video_tx.clone();
            let expected_width = params.expected_width;
            let expected_height = params.expected_height;
            let frame_scaler = params.frame_scaler.clone();
            let scaling_logged = params.scaling_logged.clone();
            let scaled_frame_count = params.scaled_frame_count.clone();
            move |frame| {
                let timestamp = frame.inner().SystemRelativeTime()?;
                let timestamp = Timestamp::PerformanceCounter(PerformanceCounterTimestamp::new(
                    timestamp.Duration,
                ));

                let frame_width = frame.width();
                let frame_height = frame.height();

                let screen_frame =
                    if frame_width != expected_width || frame_height != expected_height {
                        let Ok(mut scaler_guard) = frame_scaler.lock() else {
                            video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            return Ok(());
                        };

                        if !scaling_logged.load(atomic::Ordering::Relaxed) {
                            info!(
                                expected_width,
                                expected_height,
                                frame_width,
                                frame_height,
                                "Display resolution changed, scaling frames to match original dimensions"
                            );
                            scaling_logged.store(true, atomic::Ordering::Relaxed);
                        }

                        match scaler_guard.scale_frame(&frame) {
                            Some(scaled) => {
                                let count =
                                    scaled_frame_count.fetch_add(1, atomic::Ordering::Relaxed) + 1;
                                if count.is_multiple_of(300) {
                                    debug!(scaled_frames = count, "Scaling frames");
                                }
                                scaled
                            }
                            None => {
                                video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                return Ok(());
                            }
                        }
                    } else {
                        if scaling_logged.swap(false, atomic::Ordering::Relaxed) {
                            let count = scaled_frame_count.swap(0, atomic::Ordering::Relaxed);
                            info!(
                                scaled_frames = count,
                                "Display dimensions restored, resuming direct capture"
                            );
                            if let Ok(mut guard) = frame_scaler.lock() {
                                guard.state = None;
                            }
                        }
                        ScreenFrame::Captured(frame)
                    };

                match tx.try_send(VideoFrame {
                    frame: screen_frame,
                    timestamp,
                }) {
                    Ok(()) => {
                        video_frame_counter.fetch_add(1, atomic::Ordering::Relaxed);
                    }
                    Err(_) => {
                        video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                    }
                }
                Ok(())
            }
        },
        {
            let mut err_tx = error_tx.clone();
            move || {
                drop(err_tx.try_send(anyhow!("closed")));
                Ok(())
            }
        },
        Some(params.d3d_device.clone()),
    )
    .map_err(|e| anyhow!("{e}"))
}

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        VideoSourceConfig {
            video_info,
            display_id,
            settings,
            d3d_device,
        }: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut output_pipeline::SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (error_tx, mut error_rx) = mpsc::channel(4);
        let (ctrl_tx, ctrl_rx) = std::sync::mpsc::sync_channel::<VideoControl>(2);
        let monitor_ctrl_tx = ctrl_tx.clone();

        let tokio_rt = tokio::runtime::Handle::current();
        let restart_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let expected_width = video_info.width;
        let expected_height = video_info.height;
        let frame_scaler = Arc::new(Mutex::new(WindowsFrameScaler::new(
            expected_width,
            expected_height,
            Direct3DCapture::PIXEL_FORMAT,
            d3d_device.clone(),
        )));
        let scaling_logged: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        let scaled_frame_count: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let stats_health_tx = ctx.health_tx().clone();
        ctx.tasks().spawn_thread("d3d-capture-thread", {
            let restart_counter = restart_counter.clone();
            let frame_scaler = frame_scaler.clone();
            let scaling_logged = scaling_logged.clone();
            let scaled_frame_count = scaled_frame_count.clone();
            let stats_health_tx = stats_health_tx.clone();
            move || {
                cap_mediafoundation_utils::thread_init();

                let video_frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
                let video_drop_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
                let cancel_token = CancellationToken::new();
                let mut error_tx = error_tx;

                let capturer_params = CreateCapturerParams {
                    display_id: &display_id,
                    settings: &settings,
                    d3d_device: &d3d_device,
                    video_tx: &video_tx,
                    video_frame_counter: &video_frame_counter,
                    video_drop_counter: &video_drop_counter,
                    expected_width,
                    expected_height,
                    frame_scaler: frame_scaler.clone(),
                    scaling_logged: scaling_logged.clone(),
                    scaled_frame_count: scaled_frame_count.clone(),
                };

                let mut capturer = match create_d3d_capturer(&capturer_params, &error_tx) {
                    Ok(c) => {
                        trace!("D3D capturer created successfully");
                        Some(c)
                    }
                    Err(e) => {
                        error!("Failed to create D3D capturer: {}", e);
                        return Err(e);
                    }
                };

                let Ok(VideoControl::Start(reply)) = ctrl_rx.recv() else {
                    error!("Failed to receive Start control message - channel disconnected");
                    return Err(anyhow!("Control channel disconnected before Start"));
                };

                tokio_rt.spawn(
                    {
                        let video_frame_counter = video_frame_counter.clone();
                        let video_drop_counter = video_drop_counter.clone();
                        let restart_counter = restart_counter.clone();
                        let scaled_frame_count = scaled_frame_count.clone();
                        let stats_health_tx = stats_health_tx.clone();
                        async move {
                            loop {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                let captured = video_frame_counter.load(atomic::Ordering::Relaxed);
                                let dropped = video_drop_counter.load(atomic::Ordering::Relaxed);
                                let restarts = restart_counter.load(atomic::Ordering::Relaxed);
                                let scaled = scaled_frame_count.load(atomic::Ordering::Relaxed);
                                let total = captured + dropped;
                                if dropped > 0 || restarts > 0 || scaled > 0 {
                                    let drop_pct = if total > 0 {
                                        100.0 * dropped as f64 / total as f64
                                    } else {
                                        0.0
                                    };
                                    warn!(
                                        captured = captured,
                                        dropped = dropped,
                                        drop_pct = format!("{:.1}%", drop_pct),
                                        restarts = restarts,
                                        scaled_frames = scaled,
                                        "Screen capture stats"
                                    );
                                    if drop_pct > 5.0 {
                                        output_pipeline::emit_health(
                                            &stats_health_tx,
                                            output_pipeline::PipelineHealthEvent::FrameDropRateHigh {
                                                rate_pct: drop_pct,
                                            },
                                        );
                                    }
                                } else {
                                    debug!(captured = captured, "Screen capture frames");
                                }
                            }
                        }
                    }
                    .with_cancellation_token_owned(cancel_token.clone())
                    .in_current_span(),
                );
                let drop_guard = cancel_token.drop_guard();

                trace!("Starting D3D capturer");
                let start_result = capturer
                    .as_mut()
                    .map(|c| c.start().map_err(Into::into))
                    .unwrap_or(Err(anyhow!("No capturer available")));
                if let Err(ref e) = start_result {
                    error!("Failed to start D3D capturer: {}", e);
                }
                if reply.send(start_result).is_err() {
                    error!("Failed to send start result - receiver dropped");
                    return Ok(());
                }

                loop {
                    match ctrl_rx.recv() {
                        Ok(VideoControl::Stop(reply)) => {
                            if let Some(mut cap) = capturer.take() {
                                let _ = reply.send(cap.stop().map_err(Into::into));
                            } else {
                                let _ = reply.send(Ok(()));
                            }
                            break;
                        }
                        Ok(VideoControl::Restart) => {
                            info!("Restarting Windows screen capture");
                            output_pipeline::emit_health(
                                &stats_health_tx,
                                output_pipeline::PipelineHealthEvent::SourceRestarting,
                            );
                            if let Some(mut old) = capturer.take() {
                                let _ = old.stop();
                                drop(old);
                            }

                            match create_d3d_capturer(&capturer_params, &error_tx) {
                                Ok(mut new_cap) => match new_cap.start() {
                                    Ok(()) => {
                                        let count = restart_counter
                                            .fetch_add(1, atomic::Ordering::Relaxed)
                                            + 1;
                                        info!(
                                            restart_count = count,
                                            "Windows screen capture restarted successfully"
                                        );
                                        output_pipeline::emit_health(
                                            &stats_health_tx,
                                            output_pipeline::PipelineHealthEvent::SourceRestarted,
                                        );
                                        capturer = Some(new_cap);
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "Failed to start restarted capturer");
                                        let _ =
                                            error_tx.try_send(anyhow!("restart_start_failed: {e}"));
                                    }
                                },
                                Err(e) => {
                                    warn!(error = %e, "Failed to recreate capturer");
                                    let _ =
                                        error_tx.try_send(anyhow!("restart_create_failed: {e}"));
                                }
                            }
                        }
                        Ok(VideoControl::Start(_)) => {}
                        Err(_) => break,
                    }
                }

                drop(drop_guard);

                Ok(())
            }
        });

        ctx.tasks().spawn("d3d-capture", async move {
            let mut restart_count = 0u32;

            while let Some(err) = error_rx.next().await {
                if restart_count < MAX_CAPTURE_RESTARTS {
                    restart_count += 1;
                    warn!(
                        restart_count,
                        max_restarts = MAX_CAPTURE_RESTARTS,
                        error = %err,
                        "Windows capture interrupted, attempting restart"
                    );
                    tokio::time::sleep(RESTART_DELAY).await;
                    if monitor_ctrl_tx.try_send(VideoControl::Restart).is_err() {
                        return Err(anyhow!("Failed to send restart signal to capture thread"));
                    }
                    continue;
                }

                return Err(anyhow!(
                    "Windows screen capture failed after {} restart attempts: {err}",
                    MAX_CAPTURE_RESTARTS
                ));
            }

            Ok(())
        });

        Ok(Self {
            video_info,
            ctrl_tx,
        })
    }

    fn video_info(&self) -> VideoInfo {
        self.video_info
    }

    fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let (tx, rx) = oneshot::channel();
        let _ = self.ctrl_tx.send(VideoControl::Start(tx));

        async {
            rx.await??;
            Ok(())
        }
        .boxed()
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let (tx, rx) = oneshot::channel();
        let _ = self.ctrl_tx.send(VideoControl::Stop(tx));

        async {
            rx.await??;
            Ok(())
        }
        .boxed()
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum StartCapturingError {
    #[error("AlreadyCapturing")]
    AlreadyCapturing,
    #[error("CreateCapturer/{0}")]
    CreateCapturer(scap_direct3d::NewCapturerError),
    #[error("StartCapturer/{0}")]
    StartCapturer(::windows::core::Error),
}

const DEVICE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const SILENCE_CHUNK_DURATION: Duration = Duration::from_millis(20);
const SILENCE_CHUNKS_ON_SWITCH: usize = 5;

pub struct SystemAudioSourceConfig;

struct CapturerState {
    capturer: Option<scap_cpal::Capturer>,
    is_started: bool,
    device_name: String,
}

pub struct SystemAudioSource {
    state: Arc<std::sync::Mutex<CapturerState>>,
    cancel_token: CancellationToken,
    audio_info: AudioInfo,
}

struct SystemAudioResampler {
    context: ffmpeg::software::resampling::Context,
}

impl SystemAudioResampler {
    fn create(source_info: &AudioInfo, target_info: &AudioInfo) -> Option<Self> {
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
        Some(Self { context })
    }

    fn resample(
        &mut self,
        input: ffmpeg::frame::Audio,
        timestamp: Timestamp,
    ) -> Option<AudioFrame> {
        let mut output = ffmpeg::frame::Audio::empty();
        self.context.run(&input, &mut output).ok()?;
        Some(AudioFrame::new(output, timestamp))
    }
}

fn get_current_device_name() -> String {
    let host = cpal::default_host();
    host.default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default()
}

fn create_silence_frame(info: &AudioInfo, sample_count: usize) -> ffmpeg::frame::Audio {
    let mut frame =
        ffmpeg::frame::Audio::new(info.sample_format, sample_count, info.channel_layout());
    for i in 0..frame.planes() {
        frame.data_mut(i).fill(0);
    }
    frame.set_rate(info.sample_rate);
    frame
}

fn create_system_audio_capturer(
    mut tx: mpsc::Sender<AudioFrame>,
    frame_counter: Arc<AtomicU32>,
    drop_counter: Arc<AtomicU32>,
    error_flag: Arc<AtomicBool>,
    last_timestamp: Arc<std::sync::Mutex<Option<Timestamp>>>,
    original_info: AudioInfo,
) -> Result<scap_cpal::Capturer, scap_cpal::CapturerError> {
    let new_info = Direct3DCapture::audio_info();
    let needs_resample = new_info.sample_rate != original_info.sample_rate
        || new_info.channels != original_info.channels
        || new_info.sample_format != original_info.sample_format;

    let mut resampler = if needs_resample {
        info!(
            original_rate = original_info.sample_rate,
            new_rate = new_info.sample_rate,
            original_channels = original_info.channels,
            new_channels = new_info.channels,
            "System audio device format differs from original, creating resampler"
        );
        SystemAudioResampler::create(&new_info, &original_info)
    } else {
        None
    };

    scap_cpal::create_capturer(
        {
            let frame_counter = frame_counter.clone();
            let drop_counter = drop_counter.clone();
            let last_timestamp = last_timestamp.clone();
            move |data, info, config| {
                use scap_ffmpeg::*;

                let timestamp = Timestamp::from_cpal(info.timestamp().capture);
                let raw_frame = data.as_ffmpeg(config);

                let frame = if let Some(ref mut ctx) = resampler {
                    match ctx.resample(raw_frame, timestamp) {
                        Some(f) => f,
                        None => {
                            drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            return;
                        }
                    }
                } else {
                    AudioFrame::new(raw_frame, timestamp)
                };

                if let Ok(mut guard) = last_timestamp.lock() {
                    *guard = Some(timestamp);
                }

                const MAX_RETRIES: u32 = 3;
                const RETRY_DELAY_US: u64 = 500;

                let mut retries = 0;
                let mut current_frame = Some(frame);

                while let Some(f) = current_frame.take() {
                    match tx.try_send(f) {
                        Ok(()) => {
                            frame_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            break;
                        }
                        Err(err) if err.is_full() && retries < MAX_RETRIES => {
                            retries += 1;
                            std::thread::sleep(Duration::from_micros(RETRY_DELAY_US));
                            current_frame = Some(err.into_inner());
                        }
                        Err(_) => {
                            drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            break;
                        }
                    }
                }
            }
        },
        {
            let error_flag = error_flag.clone();
            move |e| {
                warn!("System audio CPAL stream error: {e}");
                error_flag.store(true, atomic::Ordering::Relaxed);
            }
        },
    )
}

impl output_pipeline::AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        _: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        let cancel_token = CancellationToken::new();

        ctx.tasks().spawn("system-audio", {
            let cancel = cancel_token.clone();
            async move {
                cancel.cancelled().await;
                Ok(())
            }
        });

        let audio_info = Direct3DCapture::audio_info();
        let device_name = get_current_device_name();

        let frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let drop_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let error_flag = Arc::new(AtomicBool::new(false));
        let last_timestamp: Arc<std::sync::Mutex<Option<Timestamp>>> =
            Arc::new(std::sync::Mutex::new(None));
        let device_switch_count: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let silence_frame_count: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let setup_result = create_system_audio_capturer(
            tx.clone(),
            frame_counter.clone(),
            drop_counter.clone(),
            error_flag.clone(),
            last_timestamp.clone(),
            audio_info,
        );

        let state = Arc::new(std::sync::Mutex::new(CapturerState {
            capturer: None,
            is_started: false,
            device_name,
        }));

        ctx.tasks().spawn_thread("system-audio-watcher", {
            let state = state.clone();
            let mut watcher_tx = tx.clone();
            let frame_counter = frame_counter.clone();
            let drop_counter = drop_counter.clone();
            let error_flag = error_flag.clone();
            let last_timestamp = last_timestamp.clone();
            let cancel = cancel_token.clone();
            let device_switch_count = device_switch_count.clone();
            let silence_frame_count = silence_frame_count.clone();

            move || {
                let silence_chunk_samples = (audio_info.sample_rate as f64
                    * SILENCE_CHUNK_DURATION.as_secs_f64())
                .ceil() as usize;

                loop {
                    std::thread::sleep(DEVICE_POLL_INTERVAL);

                    if cancel.is_cancelled() {
                        break;
                    }

                    let current_name = get_current_device_name();
                    let mut guard = match state.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };

                    let stream_error = error_flag.swap(false, atomic::Ordering::Relaxed);
                    let device_changed = current_name != guard.device_name;
                    let needs_retry = guard.capturer.is_none() && guard.is_started;

                    if !device_changed && !stream_error && !needs_retry {
                        continue;
                    }

                    if device_changed {
                        info!(
                            old_device = guard.device_name,
                            new_device = current_name,
                            "Default audio output device changed"
                        );
                        device_switch_count.fetch_add(1, atomic::Ordering::Relaxed);
                    } else if stream_error {
                        info!("System audio stream error detected, recreating capturer");
                    } else {
                        info!("Retrying system audio capturer creation");
                    }

                    let was_started = guard.is_started;

                    if let Some(old_capturer) = guard.capturer.take() {
                        if was_started {
                            let _ = old_capturer.pause();
                        }
                        drop(old_capturer);
                    }

                    let base_ts = last_timestamp.lock().ok().and_then(|g| *g);
                    if let Some(mut ts) = base_ts {
                        let chunk_duration = Duration::from_secs_f64(
                            silence_chunk_samples as f64 / audio_info.sample_rate as f64,
                        );
                        for _ in 0..SILENCE_CHUNKS_ON_SWITCH {
                            ts = ts + chunk_duration;
                            let silence = create_silence_frame(&audio_info, silence_chunk_samples);
                            let frame = AudioFrame::new(silence, ts);
                            if watcher_tx.try_send(frame).is_err() {
                                break;
                            }
                            silence_frame_count.fetch_add(1, atomic::Ordering::Relaxed);
                        }
                        if let Ok(mut lt) = last_timestamp.lock() {
                            *lt = Some(ts);
                        }
                    }

                    match create_system_audio_capturer(
                        watcher_tx.clone(),
                        frame_counter.clone(),
                        drop_counter.clone(),
                        error_flag.clone(),
                        last_timestamp.clone(),
                        audio_info,
                    ) {
                        Ok(new_capturer) => {
                            if was_started {
                                match new_capturer.play() {
                                    Ok(()) => {
                                        info!(
                                            device = current_name,
                                            "System audio capturer restarted on new device"
                                        );
                                    }
                                    Err(e) => {
                                        warn!(
                                            device = current_name,
                                            error = %e,
                                            "Failed to start capturer on new device, will retry"
                                        );
                                        guard.device_name = current_name;
                                        continue;
                                    }
                                }
                            }
                            guard.capturer = Some(new_capturer);
                            guard.device_name = current_name;
                        }
                        Err(e) => {
                            warn!(
                                device = current_name,
                                error = %e,
                                "Failed to create capturer for new audio device, will retry"
                            );
                            guard.device_name = current_name;
                        }
                    }
                }

                Ok(())
            }
        });

        let cancel = cancel_token.clone();

        async move {
            let capturer = setup_result.map_err(|e| anyhow!("{e}"))?;
            if let Ok(mut guard) = state.lock() {
                guard.capturer = Some(capturer);
            }

            tokio::spawn({
                let cancel = cancel.clone();
                async move {
                    loop {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                            _ = cancel.cancelled() => break,
                        }
                        let captured = frame_counter.load(atomic::Ordering::Relaxed);
                        let dropped = drop_counter.load(atomic::Ordering::Relaxed);
                        let switches = device_switch_count.load(atomic::Ordering::Relaxed);
                        let silence = silence_frame_count.load(atomic::Ordering::Relaxed);
                        let total = captured + dropped;

                        if dropped > 0 || switches > 0 {
                            let drop_pct = if total > 0 {
                                100.0 * dropped as f64 / total as f64
                            } else {
                                0.0
                            };
                            warn!(
                                captured = captured,
                                dropped = dropped,
                                drop_pct = format!("{:.1}%", drop_pct),
                                device_switches = switches,
                                silence_frames = silence,
                                "System audio capture stats"
                            );
                        } else if captured > 0 {
                            debug!(captured = captured, "System audio frames captured");
                        }
                    }
                }
            });

            Ok(Self {
                state,
                cancel_token: cancel,
                audio_info,
            })
        }
    }

    fn audio_info(&self) -> cap_media_info::AudioInfo {
        self.audio_info
    }

    fn start(&mut self) -> impl Future<Output = anyhow::Result<()>> {
        let result = match self.state.lock() {
            Ok(mut guard) => {
                guard.is_started = true;
                match &guard.capturer {
                    Some(c) => c.play().map_err(|e| anyhow!("{e}")),
                    None => Ok(()),
                }
            }
            Err(_) => Err(anyhow!("System audio state lock poisoned")),
        };
        async move { result }
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> {
        self.cancel_token.cancel();
        if let Ok(guard) = self.state.lock()
            && let Some(ref capturer) = guard.capturer
            && let Err(err) = capturer.pause()
        {
            warn!("system audio capturer pause failed: {err}");
        }
        async { Ok(()) }
    }
}
