use crate::output_pipeline::{self, AudioFrame, ChannelAudioSource, VideoSource};

use super::*;
use ::windows::{
    Graphics::Capture::GraphicsCaptureItem,
    Win32::Graphics::Direct3D11::{D3D11_BOX, ID3D11Device},
};
use anyhow::anyhow;
use cap_fail::fail_err;
use cap_timestamp::{PerformanceCounterTimestamp, Timestamps};
use cpal::traits::{DeviceTrait, HostTrait};
use futures::{FutureExt, SinkExt, channel::mpsc};
use kameo::prelude::*;
use scap_ffmpeg::*;
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

pub fn create_capturer(
    source: ScreenCaptureSource<Direct3DCapture>,
    mut video_tx: mpsc::Sender<VideoFrame>,
    mut error_tx: mpsc::Sender<anyhow::Error>,
) -> anyhow::Result<scap_direct3d::Capturer> {
    // let (error_tx, error_rx) = flume::bounded(1);
    // let capturer =
    //     ScreenCaptureActor::spawn(ScreenCaptureActor::new(error_tx, source.d3d_device.clone()));

    // let frame_handler = FrameHandler::spawn(FrameHandler {
    //     capturer: capturer.downgrade(),
    //     video_tx,
    //     frame_events: Default::default(),
    //     frames_dropped: Default::default(),
    //     last_cleanup: Instant::now(),
    //     last_log: Instant::now(),
    //     target_fps: source.config.fps,
    //     last_timestamp: None,
    //     timestamps: Timestamps::now(),
    // });

    let mut settings = scap_direct3d::Settings {
        pixel_format: Direct3DCapture::PIXEL_FORMAT,
        crop: source.config.crop_bounds.map(|b| {
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
        settings.is_cursor_capture_enabled = Some(source.config.show_cursor);
    }

    if let Ok(true) = scap_direct3d::Settings::can_min_update_interval() {
        settings.min_update_interval =
            Some(Duration::from_secs_f64(1.0 / source.config.fps as f64));
    }

    let display = Display::from_id(&source.config.display)
        .ok_or_else(|| SourceError::NoDisplay(source.config.display))?;

    let capture_item = display
        .raw_handle()
        .try_as_capture_item()
        .map_err(SourceError::AsCaptureItem)?;

    Ok(scap_direct3d::Capturer::new(
        capture_item,
        settings,
        move |frame| {
            let timestamp = frame.inner().SystemRelativeTime()?;
            let timestamp =
                Timestamp::PerformanceCounter(PerformanceCounterTimestamp::new(timestamp.Duration));
            let _ = video_tx.try_send(VideoFrame { frame, timestamp });

            Ok(())
        },
        move || {
            let _ = error_tx.try_send(anyhow!("Screen capture closed"));

            Ok(())
        },
        Some(source.d3d_device.clone()),
    )
    .map_err(StartCapturingError::CreateCapturer)?)
}

pub struct Source(
    scap_direct3d::Capturer,
    VideoInfo,
    Option<scap_cpal::Capturer>,
);

impl VideoSource for Source {
    type Config = ScreenCaptureSource<Direct3DCapture>;
    type Frame = VideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut output_pipeline::SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let system_audio = None;
        // if config.system_audio {
        //     let (mut tx, rx) = mpsc::channel(64);
        //     ctx.add_audio_source(ChannelAudioSource::new(config.audio_info(), rx));

        //     let capturer = scap_cpal::create_capturer(
        //         move |data, info, config| {
        //             use scap_ffmpeg::*;

        //             let timestamp = Timestamp::from_cpal(info.timestamp().capture);

        //             let _ = tx.try_send(AudioFrame::new(data.as_ffmpeg(config), timestamp));
        //         },
        //         move |e| {
        //             dbg!(e);
        //         },
        //     )?;

        //     Some(capturer)
        // } else {
        //     None
        // };

        let error_tx = ctx.add_error_source("Windows Screen Capture");

        let video_info = config.video_info;

        Ok(Self(
            create_capturer(config, video_tx, error_tx)?,
            video_info,
            system_audio,
        ))
    }

    fn video_info(&self) -> VideoInfo {
        self.1
    }

    fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let res = (|| {
            self.0.start()?;
            if let Some(audio) = &self.2 {
                audio
                    .play()
                    .map(|_| anyhow!("Audio capture start failed"))?;
            }
            Ok(())
        })();

        futures::future::ready(res).boxed()
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

use audio::WindowsAudioCapture;
pub mod audio {
    use super::*;
    use cpal::{PauseStreamError, PlayStreamError};

    #[derive(Actor)]
    pub struct WindowsAudioCapture {
        capturer: scap_cpal::Capturer,
    }

    unsafe impl Send for WindowsAudioCapture {}

    impl WindowsAudioCapture {
        pub fn new(
            audio_tx: Sender<(ffmpeg::frame::Audio, Timestamp)>,
        ) -> Result<Self, scap_cpal::CapturerError> {
            let capturer = scap_cpal::create_capturer(
                move |data, info, config| {
                    use scap_ffmpeg::*;

                    let timestamp = Timestamp::from_cpal(info.timestamp().capture);

                    let _ = audio_tx.send((data.as_ffmpeg(config), timestamp));
                },
                move |e| {
                    dbg!(e);
                },
            )?;

            Ok(Self { capturer })
        }
    }

    #[derive(Clone)]
    pub struct StartCapturing;

    impl Message<StartCapturing> for WindowsAudioCapture {
        type Reply = Result<(), PlayStreamError>;

        async fn handle(
            &mut self,
            _: StartCapturing,
            _: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            self.capturer.play()?;

            Ok(())
        }
    }

    impl Message<StopCapturing> for WindowsAudioCapture {
        type Reply = Result<(), PauseStreamError>;

        async fn handle(
            &mut self,
            _: StopCapturing,
            _: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            self.capturer.pause()?;

            Ok(())
        }
    }
}
