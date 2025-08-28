use super::*;
use ::windows::{
    Foundation::TimeSpan,
    Graphics::Capture::GraphicsCaptureItem,
    Win32::Graphics::Direct3D11::{D3D11_BOX, ID3D11Device},
};
use cap_fail::fail_err;
use cap_venc_mediafoundation::video::VideoEncoderInputSample;
use cpal::traits::{DeviceTrait, HostTrait};
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
pub struct AVFrameCapture;

impl AVFrameCapture {
    pub const PIXEL_FORMAT: scap_direct3d::PixelFormat = scap_direct3d::PixelFormat::R8G8B8A8Unorm;
}

impl ScreenCaptureFormat for AVFrameCapture {
    type VideoFormat = VideoEncoderInputSample;

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

struct FrameHandler {
    capturer: WeakActorRef<ScreenCaptureActor>,
    start_time: SystemTime,
    frames_dropped: u32,
    last_cleanup: Instant,
    last_log: Instant,
    frame_events: VecDeque<(Instant, bool)>,
    video_tx: Sender<(VideoEncoderInputSample, f64)>,
}

impl Actor for FrameHandler {
    type Args = Self;
    type Error = ();

    async fn on_start(args: Self::Args, self_actor: ActorRef<Self>) -> Result<Self, Self::Error> {
        if let Some(capturer) = args.capturer.upgrade() {
            self_actor.link(&capturer).await;
        }

        Ok(args)
    }

    async fn on_link_died(
        &mut self,
        actor_ref: WeakActorRef<Self>,
        id: ActorID,
        _: ActorStopReason,
    ) -> Result<std::ops::ControlFlow<ActorStopReason>, Self::Error> {
        if self.capturer.id() == id
            && let Some(self_actor) = actor_ref.upgrade()
        {
            let _ = self_actor.stop_gracefully().await;

            return Ok(std::ops::ControlFlow::Break(ActorStopReason::Normal));
        }

        Ok(std::ops::ControlFlow::Continue(()))
    }
}

impl FrameHandler {
    // Helper function to clean up old frame events
    fn cleanup_old_events(&mut self, now: Instant) {
        let cutoff = now - WINDOW_DURATION;
        while let Some(&(timestamp, _)) = self.frame_events.front() {
            if timestamp < cutoff {
                self.frame_events.pop_front();
            } else {
                break;
            }
        }
    }

    // Helper function to calculate current drop rate
    fn calculate_drop_rate(&mut self) -> (f64, usize, usize) {
        let now = Instant::now();
        self.cleanup_old_events(now);

        if self.frame_events.is_empty() {
            return (0.0, 0, 0);
        }

        let total_frames = self.frame_events.len();
        let dropped_frames = self
            .frame_events
            .iter()
            .filter(|(_, dropped)| *dropped)
            .count();
        let drop_rate = dropped_frames as f64 / total_frames as f64;

        (drop_rate, dropped_frames, total_frames)
    }
}

impl Message<NewFrame> for FrameHandler {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: NewFrame,
        ctx: &mut kameo::prelude::Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let Ok(elapsed) = msg.display_time.duration_since(self.start_time) else {
            return;
        };

        let now = Instant::now();
        let frame_dropped = match self.video_tx.try_send((msg.sample, elapsed.as_secs_f64())) {
            Err(flume::TrySendError::Disconnected(_)) => {
                warn!("Pipeline disconnected");
                let _ = ctx.actor_ref().stop_gracefully().await;
                return;
            }
            Err(flume::TrySendError::Full(_)) => {
                warn!("Screen capture sender is full, dropping frame");
                self.frames_dropped += 1;
                true
            }
            _ => false,
        };

        self.frame_events.push_back((now, frame_dropped));

        if now.duration_since(self.last_cleanup) > Duration::from_millis(100) {
            self.cleanup_old_events(now);
            self.last_cleanup = now;
        }

        // Check drop rate and potentially exit
        let (drop_rate, dropped_count, total_count) = self.calculate_drop_rate();

        if drop_rate > MAX_DROP_RATE_THRESHOLD && total_count >= 10 {
            error!(
                "High frame drop rate detected: {:.1}% ({}/{} frames in last {}s). Exiting capture.",
                drop_rate * 100.0,
                dropped_count,
                total_count,
                WINDOW_DURATION.as_secs()
            );
            let _ = ctx.actor_ref().stop_gracefully().await;
            return;
            // return ControlFlow::Break(Err("Recording can't keep up with screen capture. Try reducing your display's resolution or refresh rate.".to_string()));
        }

        // Periodic logging of drop rate
        if now.duration_since(self.last_log) > LOG_INTERVAL && total_count > 0 {
            info!(
                "Frame drop rate: {:.1}% ({}/{} frames, total dropped: {})",
                drop_rate * 100.0,
                dropped_count,
                total_count,
                self.frames_dropped
            );
            self.last_log = now;
        }
    }
}

#[derive(Clone, Debug, thiserror::Error)]
enum SourceError {
    #[error("NoDisplay: Id '{0}'")]
    NoDisplay(DisplayId),
    #[error("AsCaptureItem: {0}")]
    AsCaptureItem(::windows::core::Error),
    #[error("StartCapturingVideo/{0}")]
    StartCapturingVideo(SendError<StartCapturing, StartCapturingError>),
    #[error("CreateAudioCapture/{0}")]
    CreateAudioCapture(scap_cpal::CapturerError),
    #[error("StartCapturingAudio/{0}")]
    StartCapturingAudio(
        String, /* SendError<audio::StartCapturing, cpal::PlayStreamError> */
    ),
    #[error("Closed")]
    Closed,
}

impl PipelineSourceTask for ScreenCaptureSource<AVFrameCapture> {
    // #[instrument(skip_all)]
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();

        let start_time = self.start_time;
        let d3d_device = self.d3d_device.clone();

        // Frame drop rate tracking state
        let config = self.config.clone();

        self.tokio_handle
            .block_on(async move {
                let (error_tx, error_rx) = flume::bounded(1);
                let capturer =
                    ScreenCaptureActor::spawn(ScreenCaptureActor::new(error_tx, d3d_device));

                let frame_handler = FrameHandler::spawn(FrameHandler {
                    capturer: capturer.downgrade(),
                    video_tx,
                    start_time,
                    frame_events: Default::default(),
                    frames_dropped: Default::default(),
                    last_cleanup: Instant::now(),
                    last_log: Instant::now(),
                });

                let mut settings = scap_direct3d::Settings {
                    pixel_format: AVFrameCapture::PIXEL_FORMAT,
                    crop: config.crop_bounds.map(|b| {
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
                    settings.is_cursor_capture_enabled = Some(config.show_cursor);
                }

                if let Ok(true) = scap_direct3d::Settings::can_min_update_interval() {
                    settings.min_update_interval =
                        Some(Duration::from_secs_f64(1.0 / config.fps as f64));
                }

                let display = Display::from_id(&config.display)
                    .ok_or_else(|| SourceError::NoDisplay(config.display))?;

                let capture_item = display
                    .raw_handle()
                    .try_as_capture_item()
                    .map_err(SourceError::AsCaptureItem)?;

                capturer
                    .ask(StartCapturing {
                        target: capture_item,
                        settings,
                        frame_handler: frame_handler.clone().recipient(),
                    })
                    .await
                    .map_err(SourceError::StartCapturingVideo)?;

                let audio_capture = if let Some(audio_tx) = audio_tx {
                    let audio_capture = WindowsAudioCapture::spawn(
                        WindowsAudioCapture::new(audio_tx, start_time)
                            .map_err(SourceError::CreateAudioCapture)?,
                    );

                    audio_capture
                        .ask(audio::StartCapturing)
                        .await
                        .map_err(|v| SourceError::StartCapturingAudio(v.to_string()))?;

                    Some(audio_capture)
                } else {
                    None
                };

                let _ = ready_signal.send(Ok(()));

                let stop = async move {
                    let _ = capturer.ask(StopCapturing).await;
                    let _ = capturer.stop_gracefully().await;

                    if let Some(audio_capture) = audio_capture {
                        let _ = audio_capture.ask(StopCapturing).await;
                        let _ = audio_capture.stop_gracefully().await;
                    }
                };

                loop {
                    use futures::future::Either;

                    match futures::future::select(
                        error_rx.recv_async(),
                        control_signal.receiver().recv_async(),
                    )
                    .await
                    {
                        Either::Left((Ok(_), _)) => {
                            error!("Screen capture closed");
                            stop.await;
                            return Err(SourceError::Closed);
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
            .map_err(|e| e.to_string())
    }
}

#[derive(Actor)]
struct ScreenCaptureActor {
    capture_handle: Option<scap_direct3d::Capturer>,
    error_tx: Sender<()>,
    d3d_device: Option<ID3D11Device>,
}

impl ScreenCaptureActor {
    pub fn new(error_tx: Sender<()>, d3d_device: Option<ID3D11Device>) -> Self {
        Self {
            capture_handle: None,
            error_tx,
            d3d_device,
        }
    }
}

#[derive(Clone)]
pub struct StartCapturing {
    pub target: GraphicsCaptureItem,
    pub settings: scap_direct3d::Settings,
    pub frame_handler: Recipient<NewFrame>,
    // error_handler: Option<Recipient<CaptureError>>,
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

pub struct NewFrame {
    pub sample: VideoEncoderInputSample,
    pub display_time: SystemTime,
}

impl Message<StartCapturing> for ScreenCaptureActor {
    type Reply = Result<(), StartCapturingError>;

    async fn handle(
        &mut self,
        msg: StartCapturing,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if self.capture_handle.is_some() {
            return Err(StartCapturingError::AlreadyCapturing);
        }

        fail_err!(
            "WindowsScreenCapture.StartCapturing",
            StartCapturingError::CreateCapturer(scap_direct3d::NewCapturerError::NotSupported)
        );

        trace!("Starting capturer with settings: {:?}", &msg.settings);

        let error_tx = self.error_tx.clone();

        let mut first_time = None;

        let mut capture_handle = scap_direct3d::Capturer::new(
            msg.target,
            msg.settings,
            move |frame| {
                let display_time = SystemTime::now();

                let frame_time = frame.inner().SystemRelativeTime()?;
                let first_time = first_time.get_or_insert(frame_time);

                let timestamp = TimeSpan {
                    Duration: frame_time.Duration - first_time.Duration,
                };

                let _ = msg
                    .frame_handler
                    .tell(NewFrame {
                        sample: VideoEncoderInputSample::new(timestamp, frame.texture().clone()),
                        display_time,
                    })
                    .try_send();

                Ok(())
            },
            move || {
                let _ = error_tx.send(());

                Ok(())
            },
            None,
        )
        .map_err(StartCapturingError::CreateCapturer)?;

        capture_handle
            .start()
            .map_err(StartCapturingError::StartCapturer)?;

        info!("Capturer started");

        self.capture_handle = Some(capture_handle);

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
        let Some(mut capturer) = self.capture_handle.take() else {
            return Err(StopCapturingError::NotCapturing);
        };

        if let Err(e) = capturer.stop() {
            error!("Silently failed to stop Windows capturer: {}", e);
        }

        info!("stopped windows capturer");

        Ok(())
    }
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
            audio_tx: Sender<(ffmpeg::frame::Audio, f64)>,
            start_time: SystemTime,
        ) -> Result<Self, scap_cpal::CapturerError> {
            let mut i = 0;
            let capturer = scap_cpal::create_capturer(
                move |data, _: &cpal::InputCallbackInfo, config| {
                    use scap_ffmpeg::*;

                    let timestamp = SystemTime::now();
                    let mut ff_frame = data.as_ffmpeg(config);

                    let Ok(elapsed) = timestamp.duration_since(start_time) else {
                        warn!("Skipping audio frame {i} as elapsed time is invalid");
                        return;
                    };

                    ff_frame.set_pts(Some(
                        (elapsed.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64,
                    ));

                    let _ = audio_tx.send((ff_frame, elapsed.as_secs_f64()));
                    i += 1;
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
