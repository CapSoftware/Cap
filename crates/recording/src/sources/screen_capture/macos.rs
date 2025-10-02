use super::*;
use cidre::*;
use kameo::prelude::*;
use tracing::{debug, info, trace};

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
    #[error("StartCapturing/{0}")]
    StartCapturing(SendError<StartCapturing, StartCapturingError>),
    #[error("DidStopWithError: {0}")]
    DidStopWithError(arc::R<ns::Error>),
}

impl PipelineSourceTask for ScreenCaptureSource<CMSampleBufferCapture> {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        trace!("PipelineSourceTask::run");

        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();
        let config = self.config.clone();
        let shareable_content = self.shareable_content.clone();

        self.tokio_handle
            .block_on(async move {
                let captures_audio = audio_tx.is_some();
                let frame_handler = FrameHandler::spawn(FrameHandler { video_tx, audio_tx });

                let display = Display::from_id(&config.display)
                    .ok_or_else(|| SourceError::NoDisplay(config.display))?;

                let content_filter = display
                    .raw_handle()
                    .as_content_filter(shareable_content)
                    .await
                    .ok_or_else(|| SourceError::AsContentFilter)?;

                debug!("SCK content filter: {:?}", content_filter);

                let size = {
                    let logical_size = config
                        .crop_bounds
                        .map(|bounds| bounds.size())
                        .or_else(|| display.logical_size())
                        .unwrap();

                    let scale = display.physical_size().unwrap().width()
                        / display.logical_size().unwrap().width();

                    PhysicalSize::new(logical_size.width() * scale, logical_size.height() * scale)
                };

                debug!("size: {:?}", size);

                let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
                    .with_width(size.width() as usize)
                    .with_height(size.height() as usize)
                    .with_fps(config.fps as f32)
                    .with_shows_cursor(config.show_cursor)
                    .with_captures_audio(captures_audio)
                    .build();

                settings.set_pixel_format(cv::PixelFormat::_32_BGRA);
                settings.set_color_space_name(cg::color_space::names::srgb());

                if let Some(crop_bounds) = config.crop_bounds {
                    debug!("crop bounds: {:?}", crop_bounds);
                    settings.set_src_rect(cg::Rect::new(
                        crop_bounds.position().x(),
                        crop_bounds.position().y(),
                        crop_bounds.size().width(),
                        crop_bounds.size().height(),
                    ));
                }

                let (error_tx, error_rx) = flume::bounded(1);

                trace!("Spawning ScreenCaptureActor");

                let capturer = ScreenCaptureActor::spawn(
                    ScreenCaptureActor::new(
                        content_filter,
                        settings,
                        frame_handler.recipient(),
                        error_tx.clone(),
                    )
                    .map_err(SourceError::CreateActor)?,
                );

                info!("Spawned ScreenCaptureActor");

                capturer
                    .ask(StartCapturing)
                    .await
                    .map_err(SourceError::StartCapturing)?;

                info!("Started capturing");

                let _ = ready_signal.send(Ok(()));

                let stop = async move {
                    let _ = capturer.ask(StopCapturing).await;
                    let _ = capturer.stop_gracefully().await;
                };

                loop {
                    use futures::future::Either;

                    match futures::future::select(
                        error_rx.recv_async(),
                        control_signal.receiver().recv_async(),
                    )
                    .await
                    {
                        Either::Left((Ok(error), _)) => {
                            error!("Error capturing screen: {}", error);
                            stop.await;
                            return Err(SourceError::DidStopWithError(error));
                        }
                        Either::Right((Ok(ctrl), _)) => {
                            if let Control::Shutdown = ctrl {
                                stop.await;
                                return Ok(());
                            }
                        }
                        _ => {
                            warn!("Screen capture recv channels shutdown, exiting.");

                            stop.await;

                            return Ok(());
                        }
                    }
                }
            })
            .map_err(|e: SourceError| e.to_string())
    }
}

#[derive(Actor)]
pub struct ScreenCaptureActor {
    capturer: scap_screencapturekit::Capturer,
    capturing: bool,
}

impl ScreenCaptureActor {
    pub fn new(
        target: arc::R<sc::ContentFilter>,
        settings: arc::R<sc::StreamCfg>,
        frame_handler: Recipient<NewFrame>,
        error_tx: Sender<arc::R<ns::Error>>,
    ) -> Result<Self, arc::R<ns::Error>> {
        cap_fail::fail_err!(
            "macos::ScreenCaptureActor::new",
            ns::Error::with_domain(ns::ErrorDomain::os_status(), 69420, None)
        );

        let _error_tx = error_tx.clone();
        let capturer_builder = scap_screencapturekit::Capturer::builder(target, settings)
            .with_output_sample_buf_cb(move |frame| {
                let check_err = || {
                    cap_fail::fail_err!(
                        "macos::ScreenCaptureActor output_sample_buf",
                        ns::Error::with_domain(ns::ErrorDomain::os_status(), 69420, None)
                    );
                    Result::<_, arc::R<ns::Error>>::Ok(())
                };
                if let Err(e) = check_err() {
                    let _ = _error_tx.send(e);
                }

                let _ = frame_handler.tell(NewFrame(frame)).try_send();
            })
            .with_stop_with_err_cb(move |_, err| {
                let _ = error_tx.send(err.retained());
            });

        Ok(ScreenCaptureActor {
            capturer: capturer_builder.build()?,
            capturing: false,
        })
    }
}

// Public

pub struct StartCapturing;

// External

pub struct NewFrame(pub scap_screencapturekit::Frame);

// Internal

pub struct CaptureError(pub arc::R<ns::Error>);

#[derive(Debug, Clone, thiserror::Error)]
pub enum StartCapturingError {
    #[error("AlreadyCapturing")]
    AlreadyCapturing,
    #[error("Start: {0}")]
    Start(arc::R<ns::Error>),
}

impl Message<StartCapturing> for ScreenCaptureActor {
    type Reply = Result<(), StartCapturingError>;

    async fn handle(
        &mut self,
        _: StartCapturing,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("ScreenCaptureActor.StartCapturing");

        if self.capturing {
            return Err(StartCapturingError::AlreadyCapturing);
        }

        trace!("Starting SCK capturer");

        self.capturer
            .start()
            .await
            .map_err(StartCapturingError::Start)?;

        info!("Started SCK capturer");

        self.capturing = true;

        Ok(())
    }
}

impl Message<StopCapturing> for ScreenCaptureActor {
    type Reply = Result<(), StopCapturingError>;

    async fn handle(
        &mut self,
        _: StopCapturing,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("ScreenCaptureActor.StopCapturing");

        if !self.capturing {
            return Err(StopCapturingError::NotCapturing);
        };

        if let Err(e) = self.capturer.stop().await {
            error!("Silently failed to stop macOS capturer: {}", e);
        }

        Ok(())
    }
}
