use super::*;
use ::windows::{Graphics::Capture::GraphicsCaptureItem, Win32::Graphics::Direct3D11::D3D11_BOX};
use cpal::traits::{DeviceTrait, HostTrait};
use kameo::prelude::*;
use scap_ffmpeg::*;

#[derive(Debug)]
pub struct AVFrameCapture;

impl AVFrameCapture {
    const PIXEL_FORMAT: scap_direct3d::PixelFormat = scap_direct3d::PixelFormat::R8G8B8A8Unorm;
}

impl ScreenCaptureFormat for AVFrameCapture {
    type VideoFormat = ffmpeg::frame::Video;

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

impl PipelineSourceTask for ScreenCaptureSource<AVFrameCapture> {
    // #[instrument(skip_all)]
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        use kameo::prelude::*;

        const WINDOW_DURATION: Duration = Duration::from_secs(3);
        const LOG_INTERVAL: Duration = Duration::from_secs(5);
        const MAX_DROP_RATE_THRESHOLD: f64 = 0.25;

        let video_info = self.video_info;
        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();

        let start_time = self.start_time;

        let mut video_i = 0;
        let mut audio_i = 0;

        let mut frames_dropped = 0;

        // Frame drop rate tracking state
        use std::collections::VecDeque;
        use std::time::{Duration, Instant};

        struct FrameHandler {
            capturer: WeakActorRef<WindowsScreenCapture>,
            start_time: SystemTime,
            frames_dropped: u32,
            last_cleanup: Instant,
            last_log: Instant,
            frame_events: VecDeque<(Instant, bool)>,
            video_tx: Sender<(ffmpeg::frame::Video, f64)>,
        }

        impl Actor for FrameHandler {
            type Args = Self;
            type Error = ();

            async fn on_start(
                args: Self::Args,
                self_actor: ActorRef<Self>,
            ) -> Result<Self, Self::Error> {
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
                mut msg: NewFrame,
                ctx: &mut kameo::prelude::Context<Self, Self::Reply>,
            ) -> Self::Reply {
                let Ok(elapsed) = msg.display_time.duration_since(self.start_time) else {
                    return;
                };

                msg.ff_frame.set_pts(Some(
                    (elapsed.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64,
                ));

                let now = Instant::now();
                let frame_dropped = match self
                    .video_tx
                    .try_send((msg.ff_frame, elapsed.as_secs_f64()))
                {
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

        let config = self.config.clone();

        let _ = self.tokio_handle.block_on(async move {
            let capturer = WindowsScreenCapture::spawn(WindowsScreenCapture::new());

            let stop_recipient = capturer.clone().reply_recipient::<StopCapturing>();

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
                is_border_required: Some(false),
                pixel_format: AVFrameCapture::PIXEL_FORMAT,
                crop: config.crop_bounds.map(|b| {
                    let position = b.position();
                    let size = b.size();

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

            let display = Display::from_id(&config.display).unwrap();

            let capture_item = display.raw_handle().try_as_capture_item().unwrap();

            settings.is_cursor_capture_enabled = Some(config.show_cursor);

            let _ = capturer
                .ask(StartCapturing {
                    target: capture_item,
                    settings,
                    frame_handler: frame_handler.clone().recipient(),
                })
                .send()
                .await;

            let audio_capture = if let Some(audio_tx) = audio_tx {
                let audio_capture = WindowsAudioCapture::spawn(
                    WindowsAudioCapture::new(audio_tx, start_time).unwrap(),
                );

                let _ = dbg!(audio_capture.ask(audio::StartCapturing).send().await);

                Some(audio_capture)
            } else {
                None
            };

            let _ = ready_signal.send(Ok(()));

            while let Ok(msg) = control_signal.receiver.recv_async().await {
                if let Control::Shutdown = msg {
                    let _ = stop_recipient.ask(StopCapturing).await;

                    if let Some(audio_capture) = audio_capture {
                        let _ = audio_capture.ask(StopCapturing).await;
                    }

                    break;
                }
            }
        });

        Ok(())
    }
}

#[derive(Actor)]
pub struct WindowsScreenCapture {
    capture_handle: Option<scap_direct3d::CaptureHandle>,
}

impl WindowsScreenCapture {
    pub fn new() -> Self {
        Self {
            capture_handle: None,
        }
    }
}

pub struct StartCapturing {
    pub target: GraphicsCaptureItem,
    pub settings: scap_direct3d::Settings,
    pub frame_handler: Recipient<NewFrame>,
    // error_handler: Option<Recipient<CaptureError>>,
}

#[derive(Debug)]
pub enum StartCapturingError {
    AlreadyCapturing,
    Inner(scap_direct3d::StartCapturerError),
}

pub struct NewFrame {
    pub ff_frame: ffmpeg::frame::Video,
    pub display_time: SystemTime,
}

impl Message<StartCapturing> for WindowsScreenCapture {
    type Reply = Result<(), StartCapturingError>;

    async fn handle(
        &mut self,
        msg: StartCapturing,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if self.capture_handle.is_some() {
            return Err(StartCapturingError::AlreadyCapturing);
        }

        let capturer = scap_direct3d::Capturer::new(msg.target, msg.settings);

        let capture_handle = capturer
            .start(
                move |frame| {
                    let display_time = SystemTime::now();
                    let ff_frame = frame.as_ffmpeg().unwrap();

                    // dbg!(ff_frame.width(), ff_frame.height());

                    let _ = msg
                        .frame_handler
                        .tell(NewFrame {
                            ff_frame,
                            display_time,
                        })
                        .try_send();

                    Ok(())
                },
                || Ok(()),
            )
            .map_err(StartCapturingError::Inner)?;

        self.capture_handle = Some(capture_handle);

        Ok(())
    }
}

impl Message<StopCapturing> for WindowsScreenCapture {
    type Reply = Result<(), StopCapturingError>;

    async fn handle(
        &mut self,
        msg: StopCapturing,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let Some(capturer) = self.capture_handle.take() else {
            return Err(StopCapturingError::NotCapturing);
        };

        println!("stopping windows capturer");
        if let Err(e) = capturer.stop() {
            error!("Silently failed to stop Windows capturer: {}", e);
        }
        println!("stopped windows capturer");

        Ok(())
    }
}

use audio::WindowsAudioCapture;
pub mod audio {
    use super::*;
    use cpal::traits::StreamTrait;
    use scap_cpal::*;
    use scap_ffmpeg::*;

    #[derive(Actor)]
    pub struct WindowsAudioCapture {
        capturer: scap_cpal::Capturer,
    }

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

    pub struct StartCapturing;

    impl Message<StartCapturing> for WindowsAudioCapture {
        type Reply = Result<(), &'static str>;

        async fn handle(
            &mut self,
            msg: StartCapturing,
            ctx: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            self.capturer.play().map_err(|_| "failed to start stream")?;

            Ok(())
        }
    }

    impl Message<StopCapturing> for WindowsAudioCapture {
        type Reply = Result<(), &'static str>;

        async fn handle(
            &mut self,
            msg: StopCapturing,
            ctx: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            self.capturer.pause().map_err(|_| "failed to stop stream")?;

            Ok(())
        }
    }
}
