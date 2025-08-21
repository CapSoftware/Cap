use cap_cursor_capture::CursorCropBounds;
use cap_displays::{
    Display, DisplayId, Window, WindowId,
    bounds::{
        LogicalBounds, LogicalPosition, LogicalSize, PhysicalBounds, PhysicalPosition, PhysicalSize,
    },
};
use cap_media_info::{AudioInfo, VideoInfo};
use ffmpeg::sys::AV_TIME_BASE_Q;
use flume::Sender;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::SystemTime;
use tracing::{error, info, warn};

use crate::pipeline::{control::Control, task::PipelineSourceTask};

static EXCLUDED_WINDOWS: &[&str] = &[
    "Cap Camera",
    "Cap Recordings Overlay",
    "Cap In Progress Recording",
];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureWindow {
    pub id: WindowId,
    pub owner_name: String,
    pub name: String,
    pub bounds: LogicalBounds,
    pub refresh_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureDisplay {
    pub id: DisplayId,
    pub name: String,
    pub refresh_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureArea {
    pub screen: CaptureDisplay,
    pub bounds: LogicalBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum ScreenCaptureTarget {
    Window {
        id: WindowId,
    },
    Screen {
        id: DisplayId,
    },
    Area {
        screen: DisplayId,
        bounds: LogicalBounds,
    },
}

impl ScreenCaptureTarget {
    pub fn display(&self) -> Option<Display> {
        match self {
            Self::Screen { id } => Display::from_id(id),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.display()),
            Self::Area { screen, .. } => Display::from_id(screen),
        }
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        match self {
            Self::Screen { id } => todo!(), //  Display::from_id(id).map(|d| d.logical_bounds()),
            Self::Window { id } => Some(LogicalBounds::new(
                LogicalPosition::new(0.0, 0.0),
                Window::from_id(id)?.raw_handle().logical_size()?,
            )),
            Self::Area { bounds, .. } => Some(*bounds),
        }
    }

    pub fn cursor_crop(&self) -> Option<CursorCropBounds> {
        match self {
            Self::Screen { .. } => {
                #[cfg(target_os = "macos")]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_macos(LogicalBounds::new(
                        LogicalPosition::new(0.0, 0.0),
                        display.raw_handle().logical_size()?,
                    )));
                }

                #[cfg(windows)]
                {
                    return Some(PhysicalBounds::new(
                        PhysicalPosition::new(0.0, 0.0),
                        self.physical_size()?,
                    ));
                }
            }
            Self::Window { id } => {
                let window = Window::from_id(id)?;
                let display = self.display()?;

                #[cfg(target_os = "macos")]
                {
                    let display_position = display.raw_handle().logical_position();
                    let window_bounds = window.raw_handle().logical_bounds()?;

                    return Some(CursorCropBounds::new_macos(LogicalBounds::new(
                        LogicalPosition::new(
                            window_bounds.position().x() - display_position.x(),
                            window_bounds.position().y() - display_position.y(),
                        ),
                        window_bounds.size(),
                    )));
                }

                #[cfg(windows)]
                {
                    let display_bounds = self.display()?.physical_bounds()?;
                    let window_bounds = window.physical_bounds()?;

                    return Some(PhysicalBounds::new(
                        PhysicalPosition::new(
                            window_bounds.position().x() - display_bounds.position().x(),
                            window_bounds.position().y() - display_bounds.position().y(),
                        ),
                        PhysicalSize::new(
                            window_bounds.size().width(),
                            window_bounds.size().height(),
                        ),
                    ));
                }
            }
            Self::Area { bounds, .. } => {
                #[cfg(target_os = "macos")]
                {
                    return Some(CursorCropBounds::new_macos(*bounds));
                }

                #[cfg(windows)]
                {
                    let display = self.display()?;
                    let display_bounds = display.physical_bounds()?;
                    let display_logical_size = display.logical_size()?;

                    let scale = display_bounds.size().width() / display_logical_size.width();

                    return Some(PhysicalBounds::new(
                        PhysicalPosition::new(
                            bounds.position().x() * scale,
                            bounds.position().y() * scale,
                        ),
                        PhysicalSize::new(
                            bounds.size().width() * scale,
                            bounds.size().height() * scale,
                        ),
                    ));
                }
            }
        }
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        match self {
            Self::Screen { id } => Display::from_id(id).and_then(|d| d.physical_size()),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.physical_size()),
            Self::Area { bounds, .. } => {
                let display = self.display()?;
                let scale = display.physical_size()?.width() / display.logical_size()?.width();
                let size = bounds.size();

                Some(PhysicalSize::new(
                    size.width() * scale,
                    size.height() * scale,
                ))
            }
        }
    }

    pub fn title(&self) -> Option<String> {
        match self {
            Self::Screen { id } => Display::from_id(id).and_then(|d| d.name()),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.name()),
            Self::Area { screen, .. } => Display::from_id(screen).and_then(|d| d.name()),
        }
    }
}

pub struct ScreenCaptureSource<TCaptureFormat: ScreenCaptureFormat> {
    config: Config,
    video_info: VideoInfo,
    tokio_handle: tokio::runtime::Handle,
    video_tx: Sender<(TCaptureFormat::VideoFormat, f64)>,
    audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
    start_time: SystemTime,
    _phantom: std::marker::PhantomData<TCaptureFormat>,
}

impl<T: ScreenCaptureFormat> std::fmt::Debug for ScreenCaptureSource<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScreenCaptureSource")
            // .field("bounds", &self.bounds)
            // .field("output_resolution", &self.output_resolution)
            .field("fps", &self.config.fps)
            .field("video_info", &self.video_info)
            .field(
                "audio_info",
                &self.audio_tx.as_ref().map(|_| self.audio_info()),
            )
            .finish()
    }
}

unsafe impl<T: ScreenCaptureFormat> Send for ScreenCaptureSource<T> {}
unsafe impl<T: ScreenCaptureFormat> Sync for ScreenCaptureSource<T> {}

pub trait ScreenCaptureFormat {
    type VideoFormat;

    fn pixel_format() -> ffmpeg::format::Pixel;

    fn audio_info() -> AudioInfo;
}

impl<TCaptureFormat: ScreenCaptureFormat> Clone for ScreenCaptureSource<TCaptureFormat> {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            video_info: self.video_info,
            video_tx: self.video_tx.clone(),
            audio_tx: self.audio_tx.clone(),
            tokio_handle: self.tokio_handle.clone(),
            start_time: self.start_time,
            _phantom: std::marker::PhantomData,
        }
    }
}

#[derive(Clone, Debug)]
struct Config {
    display: DisplayId,
    #[cfg(windows)]
    crop_bounds: Option<PhysicalBounds>,
    #[cfg(target_os = "macos")]
    crop_bounds: Option<LogicalBounds>,
    fps: u32,
    show_cursor: bool,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ScreenCaptureInitError {
    #[error("NoDisplay")]
    NoDisplay,
    #[error("PhysicalSize")]
    PhysicalSize,
}

impl<TCaptureFormat: ScreenCaptureFormat> ScreenCaptureSource<TCaptureFormat> {
    #[allow(clippy::too_many_arguments)]
    pub async fn init(
        target: &ScreenCaptureTarget,
        show_cursor: bool,
        max_fps: u32,
        video_tx: Sender<(TCaptureFormat::VideoFormat, f64)>,
        audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
        start_time: SystemTime,
        tokio_handle: tokio::runtime::Handle,
    ) -> Result<Self, ScreenCaptureInitError> {
        cap_fail::fail!("media::screen_capture::init");

        let display = target.display().ok_or(ScreenCaptureInitError::NoDisplay)?;

        let fps = max_fps.min(display.refresh_rate() as u32);

        let crop_bounds = match target {
            ScreenCaptureTarget::Screen { .. } => None,
            ScreenCaptureTarget::Window { id } => {
                let window = Window::from_id(&id).unwrap();

                #[cfg(target_os = "macos")]
                {
                    let raw_display_bounds = display.raw_handle().logical_bounds().unwrap();
                    let raw_window_bounds = window.raw_handle().logical_bounds().unwrap();

                    Some(LogicalBounds::new(
                        LogicalPosition::new(
                            raw_window_bounds.position().x() - raw_display_bounds.position().x(),
                            raw_window_bounds.position().y() - raw_display_bounds.position().y(),
                        ),
                        raw_window_bounds.size(),
                    ))
                }

                #[cfg(windows)]
                {
                    let raw_display_position = display.raw_handle().physical_position().unwrap();
                    let raw_window_bounds = window.physical_bounds().unwrap();

                    Some(PhysicalBounds::new(
                        PhysicalPosition::new(
                            raw_window_bounds.position().x() - raw_display_position.x(),
                            raw_window_bounds.position().y() - raw_display_position.y(),
                        ),
                        raw_window_bounds.size(),
                    ))
                }
            }
            ScreenCaptureTarget::Area {
                bounds: relative_bounds,
                ..
            } => {
                #[cfg(target_os = "macos")]
                {
                    Some(*relative_bounds)
                }

                #[cfg(windows)]
                {
                    let raw_display_size = display.physical_size().unwrap();
                    let logical_display_size = display.logical_size().unwrap();

                    Some(PhysicalBounds::new(
                        PhysicalPosition::new(
                            (relative_bounds.position().x() / logical_display_size.width())
                                * raw_display_size.width(),
                            (relative_bounds.position().y() / logical_display_size.height())
                                * raw_display_size.height(),
                        ),
                        PhysicalSize::new(
                            (relative_bounds.size().width() / logical_display_size.width())
                                * raw_display_size.width(),
                            (relative_bounds.size().height() / logical_display_size.height())
                                * raw_display_size.height(),
                        ),
                    ))
                }
            }
        };

        let output_size = crop_bounds
            .and_then(|b| {
                #[cfg(target_os = "macos")]
                {
                    let logical_size = b.size();
                    let scale = display.raw_handle().scale()?;
                    Some(PhysicalSize::new(
                        logical_size.width() * scale,
                        logical_size.height() * scale,
                    ))
                }

                #[cfg(windows)]
                Some(b.size())
            })
            .or_else(|| display.physical_size())
            .unwrap();

        Ok(Self {
            config: Config {
                display: display.id(),
                crop_bounds,
                fps,
                show_cursor,
            },
            video_info: VideoInfo::from_raw_ffmpeg(
                TCaptureFormat::pixel_format(),
                output_size.width() as u32,
                output_size.height() as u32,
                fps,
            ),
            video_tx,
            audio_tx,
            tokio_handle,
            start_time,
            _phantom: std::marker::PhantomData,
        })
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    pub fn audio_info(&self) -> AudioInfo {
        TCaptureFormat::audio_info()
    }
}

pub fn list_displays() -> Vec<(CaptureDisplay, Display)> {
    cap_displays::Display::list()
        .into_iter()
        .filter_map(|display| {
            Some((
                CaptureDisplay {
                    id: display.id(),
                    name: display.name()?,
                    refresh_rate: display.raw_handle().refresh_rate() as u32,
                },
                display,
            ))
        })
        .collect()
}

pub fn list_windows() -> Vec<(CaptureWindow, Window)> {
    cap_displays::Window::list()
        .into_iter()
        .flat_map(|v| {
            let name = v.name()?;

            if name.is_empty() {
                return None;
            }

            #[cfg(target_os = "macos")]
            {
                if v.raw_handle().level() != Some(0)
                    || v.owner_name().filter(|v| v == "Window Server").is_some()
                {
                    return None;
                }
            }

            Some((
                CaptureWindow {
                    id: v.id(),
                    name,
                    owner_name: v.owner_name()?,
                    bounds: v.display_relative_logical_bounds()?,
                    refresh_rate: v.display()?.raw_handle().refresh_rate() as u32,
                },
                v,
            ))
        })
        .collect()
}

use kameo::prelude::*;

pub struct StopCapturing;

#[derive(Debug, Clone)]
pub enum StopCapturingError {
    NotCapturing,
}

#[cfg(windows)]
mod windows {
    use super::*;
    use ::windows::{
        Graphics::Capture::GraphicsCaptureItem, Win32::Graphics::Direct3D11::D3D11_BOX,
    };
    use cpal::traits::{DeviceTrait, HostTrait};
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

                if let Some(audio_tx) = audio_tx {
                    let audio_capture = WindowsAudioCapture::spawn(
                        WindowsAudioCapture::new(audio_tx, start_time).unwrap(),
                    );

                    let _ = audio_capture.ask(audio::StartCapturing).send().await;
                }

                let _ = ready_signal.send(Ok(()));

                while let Ok(msg) = control_signal.receiver.recv_async().await {
                    if let Control::Shutdown = msg {
                        let _ = stop_recipient.ask(StopCapturing).await;
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
    }
}

#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cidre::*;

    #[derive(Debug)]
    pub struct CMSampleBufferCapture;

    #[cfg(target_os = "macos")]
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

    #[cfg(target_os = "macos")]
    impl PipelineSourceTask for ScreenCaptureSource<CMSampleBufferCapture> {
        fn run(
            &mut self,
            ready_signal: crate::pipeline::task::PipelineReadySignal,
            control_signal: crate::pipeline::control::PipelineControlSignal,
        ) -> Result<(), String> {
            use cidre::{arc, cg, cm, cv};
            use kameo::prelude::*;

            #[derive(Actor)]
            struct FrameHandler {
                start_time_unix: f64,
                start_cmtime: f64,
                start_time_f64: f64,
                video_tx: Sender<(arc::R<cm::SampleBuf>, f64)>,
                audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
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

                    let frame_time =
                        sample_buffer.pts().value as f64 / sample_buffer.pts().scale as f64;
                    let unix_timestamp = self.start_time_unix + frame_time - self.start_cmtime;
                    let relative_time = unix_timestamp - self.start_time_f64;

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
                                && self
                                    .video_tx
                                    .send((sample_buffer.retained(), relative_time))
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
                                use cap_media_info::PlanarData;

                                frame.plane_data_mut(i).copy_from_slice(
                                    &slice[i * data_bytes_size as usize
                                        ..(i + 1) * data_bytes_size as usize],
                                );
                            }

                            frame.set_pts(Some((relative_time * AV_TIME_BASE_Q.den as f64) as i64));

                            let _ = audio_tx.send((frame, relative_time));
                        }
                        _ => {}
                    }
                }
            }

            let start = std::time::SystemTime::now();
            let start_time_unix = start
                .duration_since(std::time::UNIX_EPOCH)
                .expect("Time went backwards")
                .as_secs_f64();
            let start_cmtime = cidre::cm::Clock::host_time_clock().time();
            let start_cmtime = start_cmtime.value as f64 / start_cmtime.scale as f64;

            let start_time_f64 = self
                .start_time
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs_f64();

            let video_tx = self.video_tx.clone();
            let audio_tx = self.audio_tx.clone();
            let config = self.config.clone();

            self.tokio_handle.block_on(async move {
                let frame_handler = FrameHandler::spawn(FrameHandler {
                    video_tx,
                    audio_tx,
                    start_time_unix,
                    start_cmtime,
                    start_time_f64,
                });

                let display = Display::from_id(&config.display).unwrap();

                let content_filter = display
                    .raw_handle()
                    .as_content_filter()
                    .await
                    .ok_or_else(|| "Failed to get content filter".to_string())?;

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

                tracing::info!("size: {:?}", size);

                let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
                    .with_width(size.width() as usize)
                    .with_height(size.height() as usize)
                    .with_fps(config.fps as f32)
                    .with_shows_cursor(config.show_cursor)
                    .build();

                settings.set_pixel_format(cv::PixelFormat::_32_BGRA);

                if let Some(crop_bounds) = config.crop_bounds {
                    tracing::info!("crop bounds: {:?}", crop_bounds);
                    settings.set_src_rect(cg::Rect::new(
                        crop_bounds.position().x(),
                        crop_bounds.position().y(),
                        crop_bounds.size().width(),
                        crop_bounds.size().height(),
                    ));
                }

                let (error_tx, error_rx) = flume::bounded(1);

                let capturer = ScreenCaptureActor::spawn(
                    ScreenCaptureActor::new(
                        content_filter,
                        settings,
                        frame_handler.recipient(),
                        error_tx.clone(),
                    )
                    .unwrap(),
                );

                let stop_recipient = capturer.clone().reply_recipient::<StopCapturing>();

                let _ = capturer.ask(StartCapturing).send().await.unwrap();

                let _ = ready_signal.send(Ok(()));

                loop {
                    use futures::future::Either;

                    let check_err = || {
                        use cidre::ns;

                        Result::<_, arc::R<ns::Error>>::Ok(cap_fail::fail_err!(
                            "macos screen capture startup error",
                            ns::Error::with_domain(ns::ErrorDomain::os_status(), 1, None)
                        ))
                    };
                    if let Err(e) = check_err() {
                        let _ = error_tx.send(e);
                    }

                    match futures::future::select(
                        error_rx.recv_async(),
                        control_signal.receiver.recv_async(),
                    )
                    .await
                    {
                        Either::Left((Ok(error), _)) => {
                            error!("Error capturing screen: {}", error);
                            let _ = stop_recipient.ask(StopCapturing).await;
                            return Err(error.to_string());
                        }
                        Either::Right((Ok(ctrl), _)) => {
                            if let Control::Shutdown = ctrl {
                                let _ = stop_recipient.ask(StopCapturing).await;
                                return Ok(());
                            }
                        }
                        _ => {
                            warn!("Screen capture recv channels shutdown, exiting.");

                            let _ = stop_recipient.ask(StopCapturing).await;

                            return Ok(());
                        }
                    }
                }
            })
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
            let _error_tx = error_tx.clone();
            let capturer_builder = scap_screencapturekit::Capturer::builder(target, settings)
                .with_output_sample_buf_cb(move |frame| {
                    let check_err = || {
                        Result::<_, arc::R<ns::Error>>::Ok(cap_fail::fail_err!(
                            "macos screen capture frame error",
                            ns::Error::with_domain(ns::ErrorDomain::os_status(), 1, None)
                        ))
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

    #[derive(Debug, Clone)]
    pub enum StartCapturingError {
        AlreadyCapturing,
        Start(arc::R<ns::Error>),
    }

    impl Message<StartCapturing> for ScreenCaptureActor {
        type Reply = Result<(), StartCapturingError>;

        async fn handle(
            &mut self,
            _: StartCapturing,
            _: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            if self.capturing {
                return Err(StartCapturingError::AlreadyCapturing);
            }

            self.capturer
                .start()
                .await
                .map_err(StartCapturingError::Start)?;

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
            if !self.capturing {
                return Err(StopCapturingError::NotCapturing);
            };

            if let Err(e) = self.capturer.stop().await {
                error!("Silently failed to stop macOS capturer: {}", e);
            }

            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::*;
