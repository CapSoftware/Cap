use std::sync::{
    Arc,
    atomic::{self, AtomicBool},
};

use super::*;
use crate::output_pipeline::{
    self, AudioFrame, ChannelAudioSource, ChannelVideoSource, ChannelVideoSourceConfig, SetupCtx,
};
use anyhow::anyhow;
use cidre::*;
use futures::{FutureExt, SinkExt, channel::mpsc, future::BoxFuture};
use kameo::prelude::*;
use tracing::debug;

#[derive(Debug)]
pub struct CMSampleBufferCapture;

impl ScreenCaptureFormat for CMSampleBufferCapture {
    type VideoFormat = cidre::arc::R<cidre::cm::SampleBuf>;

    fn pixel_format() -> ffmpeg::format::Pixel {
        ffmpeg::format::Pixel::BGRA
    }

    fn audio_info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            48_000,
            2,
        )
        .unwrap()
    }
}

#[derive(Actor)]
struct FrameHandler {
    video_tx: Sender<(arc::R<cm::SampleBuf>, Timestamp)>,
    audio_tx: Option<Sender<(ffmpeg::frame::Audio, Timestamp)>>,
}

impl Message<NewFrame> for FrameHandler {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: NewFrame,
        _: &mut kameo::prelude::Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let frame = msg.0;
        let sample_buffer = frame.sample_buf();

        let mach_timestamp = cm::Clock::convert_host_time_to_sys_units(sample_buffer.pts());
        let timestamp =
            Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::new(mach_timestamp));

        match &frame {
            scap_screencapturekit::Frame::Screen(frame) => {
                if frame.image_buf().height() == 0 || frame.image_buf().width() == 0 {
                    return;
                }

                let check_skip_send = || {
                    cap_fail::fail_err!("media::sources::screen_capture::skip_send", ());

                    Ok::<(), ()>(())
                };

                if check_skip_send().is_ok()
                    && self
                        .video_tx
                        .send((sample_buffer.retained(), timestamp))
                        .is_err()
                {
                    warn!("Pipeline is unreachable");
                }
            }
            scap_screencapturekit::Frame::Audio(_) => {
                use ffmpeg::ChannelLayout;

                let res = || {
                    cap_fail::fail_err!("screen_capture audio skip", ());
                    Ok::<(), ()>(())
                };
                if res().is_err() {
                    return;
                }

                let Some(audio_tx) = &self.audio_tx else {
                    return;
                };

                let buf_list = sample_buffer.audio_buf_list::<2>().unwrap();
                let slice = buf_list.block().as_slice().unwrap();

                let mut frame = ffmpeg::frame::Audio::new(
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                    sample_buffer.num_samples() as usize,
                    ChannelLayout::STEREO,
                );
                frame.set_rate(48_000);
                let data_bytes_size = buf_list.list().buffers[0].data_bytes_size;
                for i in 0..frame.planes() {
                    frame.data_mut(i).copy_from_slice(
                        &slice[i * data_bytes_size as usize..(i + 1) * data_bytes_size as usize],
                    );
                }

                let _ = audio_tx.send((frame, timestamp));
            }
            _ => {}
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum SourceError {
    #[error("NoDisplay: Id '{0}'")]
    NoDisplay(DisplayId),
    #[error("AsContentFilter")]
    AsContentFilter,
    #[error("CreateActor: {0}")]
    CreateActor(arc::R<ns::Error>),
    #[error("DidStopWithError: {0}")]
    DidStopWithError(arc::R<ns::Error>),
}

pub struct ScreenCaptureActor {
    capturer: scap_screencapturekit::Capturer,
    capturing: bool,
}

pub struct VideoFrame {
    pub sample_buf: arc::R<cm::SampleBuf>,
    pub timestamp: Timestamp,
}

impl output_pipeline::VideoFrame for VideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

impl ScreenCaptureConfig<CMSampleBufferCapture> {
    pub async fn to_capturer_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSource>)> {
        let (mut video_tx, video_rx) = mpsc::channel(4);
        let (mut audio_tx, audio_rx) = if self.system_audio {
            let (tx, rx) = mpsc::channel(32);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };

        let display = Display::from_id(&self.config.display)
            .ok_or_else(|| SourceError::NoDisplay(self.config.display.clone()))?;

        let content_filter = display
            .raw_handle()
            .as_content_filter()
            .await
            .ok_or_else(|| SourceError::AsContentFilter)?;

        debug!("SCK content filter: {:?}", content_filter);

        let size = {
            let logical_size = self
                .config
                .crop_bounds
                .map(|bounds| bounds.size())
                .or_else(|| display.logical_size())
                .unwrap();

            let scale =
                display.physical_size().unwrap().width() / display.logical_size().unwrap().width();

            PhysicalSize::new(logical_size.width() * scale, logical_size.height() * scale)
        };

        debug!("size: {:?}", size);

        let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
            .with_width(size.width() as usize)
            .with_height(size.height() as usize)
            .with_fps(self.config.fps as f32)
            .with_shows_cursor(self.config.show_cursor)
            .with_captures_audio(self.system_audio)
            .build();

        settings.set_pixel_format(cv::PixelFormat::_32_BGRA);
        settings.set_color_space_name(cg::color_space::names::srgb());

        if let Some(crop_bounds) = self.config.crop_bounds {
            debug!("crop bounds: {:?}", crop_bounds);
            settings.set_src_rect(cg::Rect::new(
                crop_bounds.position().x(),
                crop_bounds.position().y(),
                crop_bounds.size().width(),
                crop_bounds.size().height(),
            ));
        }
        cap_fail::fail_err!(
            "macos::ScreenCaptureActor::new",
            ns::Error::with_domain(ns::ErrorDomain::os_status(), 69420, None)
        );

        let builder = scap_screencapturekit::Capturer::builder(content_filter, settings)
            .with_output_sample_buf_cb({
                // let mut error_tx = error_tx.clone();
                move |frame| {
                    let check_err = || {
                        cap_fail::fail_err!(
                            "macos::ScreenCaptureActor output_sample_buf",
                            ns::Error::with_domain(ns::ErrorDomain::os_status(), 69420, None)
                        );
                        Result::<_, arc::R<ns::Error>>::Ok(())
                    };
                    if let Err(e) = check_err() {
                        // let _ = error_tx.try_send(e.into());
                    }

                    let sample_buffer = frame.sample_buf();

                    let mach_timestamp =
                        cm::Clock::convert_host_time_to_sys_units(sample_buffer.pts());
                    let timestamp = Timestamp::MachAbsoluteTime(
                        cap_timestamp::MachAbsoluteTimestamp::new(mach_timestamp),
                    );

                    match &frame {
                        scap_screencapturekit::Frame::Screen(frame) => {
                            if frame.image_buf().height() == 0 || frame.image_buf().width() == 0 {
                                return;
                            }

                            let check_skip_send = || {
                                cap_fail::fail_err!(
                                    "media::sources::screen_capture::skip_send",
                                    ()
                                );

                                Ok::<(), ()>(())
                            };

                            if check_skip_send().is_ok()
                                && video_tx
                                    .try_send(VideoFrame {
                                        sample_buf: sample_buffer.retained(),
                                        timestamp,
                                    })
                                    .is_err()
                            {
                                warn!("Pipeline is unreachable");
                            }
                        }
                        scap_screencapturekit::Frame::Audio(_) => {
                            use ffmpeg::ChannelLayout;

                            let res = || {
                                cap_fail::fail_err!("screen_capture audio skip", ());
                                Ok::<(), ()>(())
                            };
                            if res().is_err() {
                                return;
                            }

                            let Some(audio_tx) = &mut audio_tx else {
                                return;
                            };

                            let buf_list = sample_buffer.audio_buf_list::<2>().unwrap();
                            let slice = buf_list.block().as_slice().unwrap();

                            let mut frame = ffmpeg::frame::Audio::new(
                                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                                sample_buffer.num_samples() as usize,
                                ChannelLayout::STEREO,
                            );
                            frame.set_rate(48_000);
                            let data_bytes_size = buf_list.list().buffers[0].data_bytes_size;
                            for i in 0..frame.planes() {
                                frame.data_mut(i).copy_from_slice(
                                    &slice[i * data_bytes_size as usize
                                        ..(i + 1) * data_bytes_size as usize],
                                );
                            }

                            let _ = audio_tx.try_send(AudioFrame::new(frame, timestamp));
                        }
                        _ => {}
                    }
                }
            })
            .with_stop_with_err_cb(move |_, err| {
                // error_tx.try_send(anyhow::format_err!("{err}"));
            });

        let capturer = Capturer::new(Arc::new(builder.build()?));
        Ok((
            VideoSourceConfig(
                ChannelVideoSourceConfig::new(self.video_info, video_rx),
                capturer.clone(),
            ),
            audio_rx.map(|rx| {
                SystemAudioSource(
                    ChannelAudioSource::new(self.audio_info(), rx),
                    capturer.clone(),
                )
            }),
        ))
    }
}

// Public

pub struct StartCapturing;

// External

pub struct NewFrame(pub scap_screencapturekit::Frame);

// Internal

pub struct CaptureError(pub arc::R<ns::Error>);

#[derive(Clone)]
struct Capturer {
    started: Arc<AtomicBool>,
    capturer: Arc<scap_screencapturekit::Capturer>,
}

impl Capturer {
    fn new(capturer: Arc<scap_screencapturekit::Capturer>) -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            capturer,
        }
    }
}

pub struct VideoSourceConfig(ChannelVideoSourceConfig<VideoFrame>, Capturer);
pub struct VideoSource(ChannelVideoSource<VideoFrame>, Capturer);

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        ChannelVideoSource::setup(config.0, video_tx, ctx)
            .await
            .map(|source| Self(source, config.1))
    }

    fn start(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            if self.1.started.fetch_and(true, atomic::Ordering::Relaxed) {
                self.1.capturer.start().await?;
            }

            Ok(())
        }
        .boxed()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            if self.1.started.fetch_and(false, atomic::Ordering::Relaxed) {
                self.1.capturer.stop().await?;
            }

            Ok(())
        }
        .boxed()
    }

    fn video_info(&self) -> VideoInfo {
        self.0.video_info()
    }
}

pub struct SystemAudioSource(ChannelAudioSource, Capturer);

impl output_pipeline::AudioSource for SystemAudioSource {
    async fn setup(self, tx: mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioInfo> {
        self.0.setup(tx).await
    }
}
