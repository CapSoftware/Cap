use crate::{
    AudioFrame, ChannelAudioSource, ChannelVideoSource, ChannelVideoSourceConfig, SetupCtx,
    output_pipeline,
    screen_capture::{ScreenCaptureConfig, ScreenCaptureFormat},
};
use ::windows::{
    Graphics::Capture::GraphicsCaptureItem,
    Win32::Graphics::Direct3D11::{D3D11_BOX, ID3D11Device},
};
use anyhow::anyhow;
use cap_fail::fail_err;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{PerformanceCounterTimestamp, Timestamp, Timestamps};
use cpal::traits::{DeviceTrait, HostTrait};
use futures::{
    FutureExt, SinkExt,
    channel::{mpsc, oneshot},
};
use kameo::prelude::*;
use scap_ffmpeg::*;
use scap_targets::{Display, DisplayId};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tracing::{info, trace};

const WINDOW_DURATION: Duration = Duration::from_secs(3);
const LOG_INTERVAL: Duration = Duration::from_secs(5);
const MAX_DROP_RATE_THRESHOLD: f64 = 0.25;

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

#[derive(Clone, Debug, thiserror::Error)]
enum SourceError {
    #[error("NoDisplay: Id '{0}'")]
    NoDisplay(DisplayId),
    #[error("AsCaptureItem: {0}")]
    AsCaptureItem(::windows::core::Error),
    #[error("CreateAudioCapture/{0}")]
    CreateAudioCapture(scap_cpal::CapturerError),
    #[error("StartCapturingAudio/{0}")]
    StartCapturingAudio(
        String, /* SendError<audio::StartCapturing, cpal::PlayStreamError> */
    ),
    #[error("Closed")]
    Closed,
}

struct CapturerHandle {}

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
	pub async fn to_sources(&self) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let (error_tx, error_rx) = oneshot::channel();
        let (mut video_tx, video_rx) = mpsc::channel(4);

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

        let display = Display::from_id(&self.config.display)
            .ok_or_else(|| SourceError::NoDisplay(self.config.display.clone()))?;

        let capture_item = display
            .raw_handle()
            .try_as_capture_item()
            .map_err(SourceError::AsCaptureItem)?;

        let mut error_tx = Some(error_tx);
        let capturer = scap_direct3d::Capturer::new(
            capture_item,
            settings,
            move |frame| {
                let timestamp = frame.inner().SystemRelativeTime()?;
                let timestamp = Timestamp::PerformanceCounter(PerformanceCounterTimestamp::new(
                    timestamp.Duration,
                ));
                let _ = video_tx.try_send(VideoFrame { frame, timestamp });

                Ok(())
            },
            move || {
                if let Some(error_tx) = error_tx.take() {
                    let _ = error_tx.send(VideoSourceError::Closed);
                }

                Ok(())
            },
            Some(self.d3d_device.clone()),
        )
        .map_err(StartCapturingError::CreateCapturer)?;

        Ok((
	        VideoSourceConfig(
	            ChannelVideoSourceConfig::new(self.video_info, video_rx),
	            capturer,
	            error_rx,
	        ),
			self.system_audio.then(|| SystemAudioSourceConfig)
		))
    }
}

#[derive(thiserror::Error, Clone, Copy, Debug)]
pub enum VideoSourceError {
    #[error("Screen capture closed")]
    Closed,
}

pub struct VideoSourceConfig(
    ChannelVideoSourceConfig<VideoFrame>,
    pub scap_direct3d::Capturer,
    oneshot::Receiver<VideoSourceError>,
);
pub struct VideoSource(ChannelVideoSource<VideoFrame>, scap_direct3d::Capturer);

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut output_pipeline::SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        ctx.tasks().spawn("screen-capture", async move {
            if let Ok(err) = config.2.await {
                return Err(anyhow!("{err}"));
            }

            Ok(())
        });

        ChannelVideoSource::setup(config.0, video_tx, ctx)
            .await
            .map(|source| Self(source, config.1))
    }

    fn video_info(&self) -> VideoInfo {
    	self.0.video_info()
    }

    fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let a = self.0.start();
        let b = self.1.start();

        async {
            b?;
            a.await
        }
        .boxed()
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let a = self.0.stop();
        let b = self.1.stop();

        async {
            b?;
            a.await
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

    async fn start(&mut self) -> anyhow::Result<()> {
        self.capturer.play()?;
        Ok(())
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        self.capturer.pause()?;
        Ok(())
    }
}
