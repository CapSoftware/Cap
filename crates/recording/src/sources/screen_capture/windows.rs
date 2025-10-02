use super::*;
use ::windows::{
    Graphics::Capture::GraphicsCaptureItem,
    Win32::Graphics::Direct3D11::{D3D11_BOX, ID3D11Device},
};
use cap_fail::fail_err;
use cap_timestamp::{PerformanceCounterTimestamp, Timestamps};
use cpal::traits::{DeviceTrait, HostTrait};
use futures::channel::oneshot;
use kameo::prelude::*;
use scap_direct3d::StopCapturerError;
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

struct FrameHandler {
    capturer: WeakActorRef<ScreenCaptureActor>,
    frames_dropped: u32,
    last_cleanup: Instant,
    last_log: Instant,
    frame_events: VecDeque<(Instant, bool)>,
    video_tx: Sender<(scap_direct3d::Frame, Timestamp)>,
    target_fps: u32,
    last_timestamp: Option<Timestamp>,
    timestamps: Timestamps,
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
        let Ok(timestamp) = msg.0.inner().SystemRelativeTime() else {
            return;
        };

        let timestamp =
            Timestamp::PerformanceCounter(PerformanceCounterTimestamp::new(timestamp.Duration));

        // manual FPS limiter
        if let Some(last_timestamp) = self.last_timestamp
            && let Some(time_since_last) = timestamp
                .duration_since(self.timestamps)
                .checked_sub(last_timestamp.duration_since(self.timestamps))
        {
            let target_interval = 1.0 / self.target_fps as f32;
            let tolerance = target_interval * 0.8; // Allow 20% early arrival

            if time_since_last.as_secs_f32() < tolerance {
                return;
            }
        }

        self.last_timestamp = Some(timestamp);

        let frame_dropped = match self.video_tx.try_send((msg.0, timestamp)) {
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

        let now = Instant::now();

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

impl PipelineSourceTask for ScreenCaptureSource<Direct3DCapture> {
    // #[instrument(skip_all)]
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();

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
                    frame_events: Default::default(),
                    frames_dropped: Default::default(),
                    last_cleanup: Instant::now(),
                    last_log: Instant::now(),
                    target_fps: config.fps,
                    last_timestamp: None,
                    timestamps: Timestamps::now(),
                });

                let mut settings = scap_direct3d::Settings {
                    pixel_format: Direct3DCapture::PIXEL_FORMAT,
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
                        WindowsAudioCapture::new(audio_tx)
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
    stop_tx: Option<std::sync::mpsc::SyncSender<oneshot::Sender<Result<(), StopCapturerError>>>>,
    error_tx: Sender<()>,
    d3d_device: ID3D11Device,
}

impl ScreenCaptureActor {
    pub fn new(error_tx: Sender<()>, d3d_device: ID3D11Device) -> Self {
        Self {
            stop_tx: None,
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

pub struct NewFrame(pub scap_direct3d::Frame);

impl Message<StartCapturing> for ScreenCaptureActor {
    type Reply = Result<(), StartCapturingError>;

    async fn handle(
        &mut self,
        msg: StartCapturing,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if self.stop_tx.is_some() {
            return Err(StartCapturingError::AlreadyCapturing);
        }

        fail_err!(
            "WindowsScreenCapture.StartCapturing",
            StartCapturingError::CreateCapturer(scap_direct3d::NewCapturerError::NotSupported)
        );

        trace!("Starting capturer with settings: {:?}", &msg.settings);

        let error_tx = self.error_tx.clone();

        let (ready_tx, ready_rx) = oneshot::channel();

        let (stop_tx, stop_rx) =
            std::sync::mpsc::sync_channel::<oneshot::Sender<Result<(), StopCapturerError>>>(1);

        let d3d_device = self.d3d_device.clone();
        std::thread::spawn(move || {
            cap_mediafoundation_utils::thread_init();

            let res = (|| {
                let mut capture_handle = scap_direct3d::Capturer::new(
                    msg.target,
                    msg.settings,
                    move |frame| {
                        let _ = msg.frame_handler.tell(NewFrame(frame)).try_send();

                        Ok(())
                    },
                    move || {
                        let _ = error_tx.send(());

                        Ok(())
                    },
                    Some(d3d_device),
                )
                .map_err(StartCapturingError::CreateCapturer)?;

                capture_handle
                    .start()
                    .map_err(StartCapturingError::StartCapturer)?;

                Ok::<_, StartCapturingError>(capture_handle)
            })();

            let mut capturer = match res {
                Ok(capturer) => {
                    let _ = ready_tx.send(Ok(()));
                    capturer
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };

            let stop_channel = stop_rx.recv();

            let res = capturer.stop();

            if let Ok(stop_channel) = stop_channel {
                let _ = stop_channel.send(res);
            }
        });

        if let Ok(res) = ready_rx.await {
            res?;
        }

        info!("Capturer started");

        self.stop_tx = Some(stop_tx);

        Ok(())
    }
}

impl Message<StopCapturing> for ScreenCaptureActor {
    type Reply = Result<(), String>;

    async fn handle(
        &mut self,
        _: StopCapturing,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let Some(stop_tx) = self.stop_tx.take() else {
            return Err("Not Capturing".to_string());
        };

        let (done_tx, done_rx) = oneshot::channel();
        if let Err(e) = stop_tx.send(done_tx) {
            error!("Silently failed to stop Windows capturer: {}", e);
        }

        if let Ok(res) = done_rx.await {
            res.map_err(|e| e.to_string())?;
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
