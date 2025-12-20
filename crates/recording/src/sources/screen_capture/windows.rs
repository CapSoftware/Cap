use crate::{
    AudioFrame, SetupCtx, output_pipeline,
    screen_capture::{ScreenCaptureConfig, ScreenCaptureFormat},
};
use ::windows::Win32::Graphics::Direct3D11::{D3D11_BOX, ID3D11Device};
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
        Arc,
        atomic::{self, AtomicU32},
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
        let output_device = host.default_output_device().unwrap();
        let supported_config = output_device.default_output_config().unwrap();

        let mut info = AudioInfo::from_stream_config(&supported_config);

        info.sample_format = ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed);

        info
    }
}

pub struct VideoFrame {
    pub frame: scap_direct3d::Frame,
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

                D3D11_BOX {
                    left: position.x() as u32,
                    top: position.y() as u32,
                    right: (position.x() + size.width()) as u32,
                    bottom: (position.y() + size.height()) as u32,
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
}

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        VideoSourceConfig {
            video_info,
            display_id,
            settings,
            d3d_device, // Share the D3D device with the encoder to avoid device mismatch
        }: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut output_pipeline::SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (error_tx, mut error_rx) = mpsc::channel(1);
        let (ctrl_tx, ctrl_rx) = std::sync::mpsc::sync_channel::<VideoControl>(1);

        let tokio_rt = tokio::runtime::Handle::current();

        ctx.tasks().spawn_thread("d3d-capture-thread", move || {
            cap_mediafoundation_utils::thread_init();

            // Look up the display and create the GraphicsCaptureItem on this thread to avoid COM threading issues
            let capture_item = match Display::from_id(&display_id) {
                Some(display) => {
                    match display.raw_handle().try_as_capture_item() {
                        Ok(item) => {
                            trace!("GraphicsCaptureItem created successfully on capture thread");
                            item
                        }
                        Err(e) => {
                            error!("Failed to create GraphicsCaptureItem on capture thread: {}", e);
                            return Err(anyhow!("Failed to create GraphicsCaptureItem: {}", e));
                        }
                    }
                }
                None => {
                    error!("Display not found for ID: {:?}", display_id);
                    return Err(anyhow!("Display not found for ID: {:?}", display_id));
                }
            };

            let video_frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
            let cancel_token = CancellationToken::new();

            let res = scap_direct3d::Capturer::new(
                capture_item,
                settings,
                {
	                let video_frame_counter = video_frame_counter.clone();
	                move |frame| {
	                	video_frame_counter.fetch_add(1, atomic::Ordering::Relaxed);
	                    let timestamp = frame.inner().SystemRelativeTime()?;
	                    let timestamp = Timestamp::PerformanceCounter(
	                        PerformanceCounterTimestamp::new(timestamp.Duration),
	                    );
	                    let _ = video_tx.try_send(VideoFrame { frame, timestamp });

	                    Ok(())
	                }
                },
                {
                    let mut error_tx = error_tx.clone();
                    move || {
                        drop(error_tx.try_send(anyhow!("closed")));

                        Ok(())
                    }
                },
                Some(d3d_device), // Use the same D3D device as the encoder
            );

            let mut capturer = match res {
                Ok(capturer) => {
                    trace!("D3D capturer created successfully");
                    capturer
                }
                Err(e) => {
                    error!("Failed to create D3D capturer: {}", e);
                    return Err(e.into());
                }
            };

            let Ok(VideoControl::Start(reply)) = ctrl_rx.recv() else {
                error!("Failed to receive Start control message - channel disconnected");
                return Err(anyhow!("Control channel disconnected before Start"));
            };

            tokio_rt.spawn(
                async move {
	                loop {
	                    tokio::time::sleep(Duration::from_secs(5)).await;
	                    debug!(
	                        "Captured {} frames",
	                        video_frame_counter.load(atomic::Ordering::Relaxed)
	                    );
	                }
	            }
	            .with_cancellation_token_owned(cancel_token.clone())
	            .in_current_span()
            );
			let drop_guard = cancel_token.drop_guard();

            trace!("Starting D3D capturer");
            let start_result = capturer.start().map_err(Into::into);
            if let Err(ref e) = start_result {
                error!("Failed to start D3D capturer: {}", e);
            }
            if reply.send(start_result).is_err() {
                error!("Failed to send start result - receiver dropped");
                return Ok(());
            }

            let Ok(VideoControl::Stop(reply)) = ctrl_rx.recv() else {
                trace!("Failed to receive Stop control message - channel disconnected (expected during shutdown)");
                return Ok(());
            };

            if reply.send(capturer.stop().map_err(Into::into)).is_err() {
            	return Ok(());
            }

            drop(drop_guard);

            Ok(())
        });

        ctx.tasks().spawn("d3d-capture", async move {
            if let Some(err) = error_rx.next().await {
                return Err(anyhow!("{err}"));
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

pub struct SystemAudioSourceConfig;

pub struct SystemAudioSource {
    capturer: scap_cpal::Capturer,
}

impl output_pipeline::AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        _: Self::Config,
        mut tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        let (error_tx, error_rx) = oneshot::channel();

        ctx.tasks().spawn("system-audio", async move {
            if let Ok(err) = error_rx.await {
                return Err(anyhow!("{err}"));
            }

            Ok(())
        });

        async {
            let mut error_tx = Some(error_tx);

            let capturer = scap_cpal::create_capturer(
                move |data, info, config| {
                    use scap_ffmpeg::*;

                    let timestamp = Timestamp::from_cpal(info.timestamp().capture);

                    let _ = tx.try_send(AudioFrame::new(data.as_ffmpeg(config), timestamp));
                },
                move |e| {
                    if let Some(error_tx) = error_tx.take() {
                        let _ = error_tx.send(e);
                    }
                },
            )?;

            Ok(Self { capturer })
        }
    }

    fn audio_info(&self) -> cap_media_info::AudioInfo {
        Direct3DCapture::audio_info()
    }

    fn start(&mut self) -> impl Future<Output = anyhow::Result<()>> {
        let res = self.capturer.play().map_err(Into::into);
        async { res }
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> {
        let res = self.capturer.pause();

        async move {
            if let Err(err) = res {
                warn!("system audio capturer pause failed: {err}");
            }

            Ok(())
        }
    }
}
