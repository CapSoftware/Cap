use super::*;
use crate::{
    ChannelAudioSourceConfig,
    output_pipeline::{
        self, AudioFrame, ChannelAudioSource, ChannelVideoSource, ChannelVideoSourceConfig,
        SetupCtx,
    },
};
use anyhow::{Context, anyhow};
use cap_timestamp::Timestamp;
use cidre::*;
use futures::{FutureExt as _, channel::mpsc, future::BoxFuture};
use std::{
    sync::{
        Arc,
        atomic::{self, AtomicBool, AtomicU32},
    },
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_util::{
    future::FutureExt as _,
    sync::{CancellationToken, DropGuard},
};
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

#[derive(Debug, thiserror::Error)]
enum SourceError {
    #[error("NoDisplay: Id '{0}'")]
    NoDisplay(DisplayId),
    #[error("AsContentFilter")]
    AsContentFilter,
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
    pub async fn to_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let (error_tx, error_rx) = broadcast::channel(1);
        // Increased from 4 to 12 to provide more buffer tolerance for frame processing delays
        let (video_tx, video_rx) = flume::bounded(12);
        let (mut audio_tx, audio_rx) = if self.system_audio {
            let (tx, rx) = mpsc::channel(32);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };

        let display = Display::from_id(&self.config.display)
            .ok_or_else(|| SourceError::NoDisplay(self.config.display.clone()))?;

        let excluded_sc_windows = if self.excluded_windows.is_empty() {
            Vec::new()
        } else {
            let mut collected = Vec::new();

            for window_id in &self.excluded_windows {
                let Some(window) = Window::from_id(window_id) else {
                    continue;
                };

                if let Some(sc_window) = window
                    .raw_handle()
                    .as_sc(self.shareable_content.clone())
                    .await
                {
                    collected.push(sc_window);
                }
            }

            collected
        };

        let content_filter = display
            .raw_handle()
            .as_content_filter_excluding_windows(
                self.shareable_content.clone(),
                excluded_sc_windows,
            )
            .await
            .ok_or(SourceError::AsContentFilter)?;

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

        let queue_depth = ((self.config.fps as f32 / 30.0 * 5.0).ceil() as isize).clamp(3, 8);
        debug!("Using queue depth: {}", queue_depth);

        let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
            .with_width(size.width() as usize)
            .with_height(size.height() as usize)
            .with_fps(self.config.fps as f32)
            .with_shows_cursor(self.config.show_cursor)
            .with_captures_audio(self.system_audio)
            .with_queue_depth(queue_depth)
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

        let video_frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let builder = scap_screencapturekit::Capturer::builder(content_filter, settings)
            .with_output_sample_buf_cb({
                let video_frame_count = video_frame_counter.clone();
                move |frame| {
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

                            cap_fail::fail_ret!("screen_capture video frame skip");

                            video_frame_count.fetch_add(1, atomic::Ordering::Relaxed);

                            let _ = video_tx.try_send(VideoFrame {
                                sample_buf: sample_buffer.retained(),
                                timestamp,
                            });
                        }
                        scap_screencapturekit::Frame::Audio(_) => {
                            use ffmpeg::ChannelLayout;

                            cap_fail::fail_ret!("screen_capture audio frame skip");

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
            .with_stop_with_err_cb({
                let video_frame_count = video_frame_counter.clone();
                move |_, err| {
                    debug!(
                        "Capturer stopping after creating {} video frames",
                        video_frame_count.load(atomic::Ordering::Relaxed)
                    );

                    let _ = error_tx.send(err.retained());
                }
            });

        let cancel_token = CancellationToken::new();
        let capturer = Capturer::new(Arc::new(builder.build()?));

        Ok((
            VideoSourceConfig {
                inner: ChannelVideoSourceConfig::new(self.video_info, video_rx),
                capturer: capturer.clone(),
                error_rx: error_rx.resubscribe(),
                video_frame_counter: video_frame_counter.clone(),
                cancel_token: cancel_token.clone(),
                drop_guard: cancel_token.drop_guard(),
            },
            audio_rx.map(|rx| {
                SystemAudioSourceConfig(
                    ChannelAudioSourceConfig::new(self.audio_info(), rx),
                    capturer,
                    error_rx,
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

struct Capturer {
    started: Arc<AtomicBool>,
    capturer: Arc<scap_screencapturekit::Capturer>,
    // error_rx: broadcast::Receiver<arc::R<ns::Error>>,
}

impl Clone for Capturer {
    fn clone(&self) -> Self {
        Self {
            started: self.started.clone(),
            capturer: self.capturer.clone(),
            // error_rx: self.error_rx.resubscribe(),
        }
    }
}

impl Capturer {
    fn new(
        capturer: Arc<scap_screencapturekit::Capturer>,
        // error_rx: broadcast::Receiver<arc::R<ns::Error>>,
    ) -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            capturer,
            // error_rx,
        }
    }

    async fn start(&mut self) -> anyhow::Result<()> {
        if !self.started.fetch_xor(true, atomic::Ordering::Relaxed) {
            self.capturer.start().await?;
        }

        Ok(())
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        if self.started.fetch_xor(true, atomic::Ordering::Relaxed) {
            self.capturer.stop().await.context("capturer_stop")?;
        }

        Ok(())
    }
}

pub struct VideoSourceConfig {
    inner: ChannelVideoSourceConfig<VideoFrame>,
    capturer: Capturer,
    error_rx: broadcast::Receiver<arc::R<ns::Error>>,
    cancel_token: CancellationToken,
    drop_guard: DropGuard,
    video_frame_counter: Arc<AtomicU32>,
}
pub struct VideoSource {
    inner: ChannelVideoSource<VideoFrame>,
    capturer: Capturer,
    cancel_token: CancellationToken,
    video_frame_counter: Arc<AtomicU32>,
    _drop_guard: DropGuard,
}

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        mut config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        ctx.tasks().spawn("screen-capture", async move {
            if let Ok(err) = config.error_rx.recv().await {
                return Err(anyhow!("{err}"));
            }

            Ok(())
        });

        ChannelVideoSource::setup(config.inner, video_tx, ctx)
            .await
            .map(|source| Self {
                inner: source,
                capturer: config.capturer,
                cancel_token: config.cancel_token,
                _drop_guard: config.drop_guard,
                video_frame_counter: config.video_frame_counter,
            })
    }

    fn start(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            self.capturer.start().await?;

            tokio::spawn({
                let video_frame_count = self.video_frame_counter.clone();
                async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        debug!(
                            "Captured {} frames",
                            video_frame_count.load(atomic::Ordering::Relaxed)
                        );
                    }
                }
                .with_cancellation_token_owned(self.cancel_token.clone())
                .in_current_span()
            });

            Ok(())
        }
        .boxed()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            debug!(
                "Capturer stopping after creating {} video frames",
                self.video_frame_counter.load(atomic::Ordering::Relaxed)
            );
            self.capturer.stop().await?;

            self.cancel_token.cancel();

            Ok(())
        }
        .boxed()
    }

    fn video_info(&self) -> VideoInfo {
        self.inner.video_info()
    }
}

pub struct SystemAudioSourceConfig(
    ChannelAudioSourceConfig,
    Capturer,
    broadcast::Receiver<arc::R<ns::Error>>,
);

pub struct SystemAudioSource(ChannelAudioSource, Capturer);

impl output_pipeline::AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        mut config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        ctx.tasks().spawn("system-audio", async move {
            if let Ok(err) = config.2.recv().await {
                return Err(anyhow!("{err}"));
            }

            Ok(())
        });

        ChannelAudioSource::setup(config.0, tx, ctx).map(|v| v.map(|source| Self(source, config.1)))
    }

    async fn start(&mut self) -> anyhow::Result<()> {
        self.1.start().await?;

        Ok(())
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        self.1.stop().await?;

        Ok(())
    }

    fn audio_info(&self) -> AudioInfo {
        self.0.audio_info()
    }
}
