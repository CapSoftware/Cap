use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{
        self, SetupCtx, StallSendOutcome, VideoSource, send_with_stall_budget_futures,
    },
    sources::screen_capture,
};
use anyhow::{Context, anyhow};
use cap_media_info::VideoInfo;
use cap_timestamp::Timestamp;
use ffmpeg::format::Pixel;
use futures::{FutureExt, StreamExt, channel::mpsc};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const CAMERA_ATTACH_TIMEOUT: Duration = Duration::from_millis(1500);
const CAMERA_STALE_AFTER: Duration = Duration::from_secs(1);
const SCREEN_CHANNEL_CAPACITY: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Coordinates refer to the capture frame before the encoder applies output resizing.
pub struct LinuxCameraRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxCameraShape {
    Round,
    RoundedRectangle { radius_pixels: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxCameraEffect {
    None,
    BackgroundBlur,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxCameraPresentation {
    pub rect: LinuxCameraRect,
    pub shape: LinuxCameraShape,
    pub mirrored: bool,
    pub effect: LinuxCameraEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LinuxCameraPresentationError {
    #[error("Camera presentation dimensions must be nonzero")]
    EmptyDimensions,
    #[error("Camera presentation must fit entirely within the capture frame")]
    OutsideCapture,
    #[error("Round camera presentation requires equal width and height")]
    NonSquareCircle,
    #[error("Camera corner radius exceeds half the shorter edge")]
    InvalidRadius,
    #[error("Camera background blur requires a processed camera stream")]
    UnsupportedEffect,
    #[error("Camera presentation requires a selected camera")]
    MissingCamera,
    #[error("Camera presentation requires a screen capture target")]
    UnsupportedTarget,
}

impl LinuxCameraPresentation {
    pub fn validate(self, width: u32, height: u32) -> Result<(), LinuxCameraPresentationError> {
        let rect = self.rect;
        if width == 0 || height == 0 || rect.width == 0 || rect.height == 0 {
            return Err(LinuxCameraPresentationError::EmptyDimensions);
        }
        if rect
            .x
            .checked_add(rect.width)
            .is_none_or(|right| right > width)
            || rect
                .y
                .checked_add(rect.height)
                .is_none_or(|bottom| bottom > height)
        {
            return Err(LinuxCameraPresentationError::OutsideCapture);
        }
        match self.shape {
            LinuxCameraShape::Round if rect.width != rect.height => {
                return Err(LinuxCameraPresentationError::NonSquareCircle);
            }
            LinuxCameraShape::RoundedRectangle { radius_pixels }
                if radius_pixels > rect.width.min(rect.height) / 2 =>
            {
                return Err(LinuxCameraPresentationError::InvalidRadius);
            }
            _ => {}
        }
        if self.effect != LinuxCameraEffect::None {
            return Err(LinuxCameraPresentationError::UnsupportedEffect);
        }
        Ok(())
    }

    pub fn resolve(
        self,
        reference: (u32, u32),
        actual: (u32, u32),
    ) -> Result<Self, LinuxCameraPresentationError> {
        let geometry = Self {
            effect: LinuxCameraEffect::None,
            ..self
        };
        geometry.validate(reference.0, reference.1)?;
        if actual.0 == 0 || actual.1 == 0 {
            return Err(LinuxCameraPresentationError::EmptyDimensions);
        }
        let scale = |value: u32, from: u32, to: u32| -> u32 {
            ((u64::from(value) * u64::from(to) + u64::from(from) / 2) / u64::from(from)) as u32
        };
        let x = scale(self.rect.x, reference.0, actual.0);
        let y = scale(self.rect.y, reference.1, actual.1);
        let right = scale(self.rect.x + self.rect.width, reference.0, actual.0);
        let bottom = scale(self.rect.y + self.rect.height, reference.1, actual.1);
        let shape = match self.shape {
            LinuxCameraShape::Round
                if right.saturating_sub(x).abs_diff(bottom.saturating_sub(y)) == 1 =>
            {
                LinuxCameraShape::RoundedRectangle {
                    radius_pixels: right.saturating_sub(x).min(bottom.saturating_sub(y)) / 2,
                }
            }
            LinuxCameraShape::Round => LinuxCameraShape::Round,
            LinuxCameraShape::RoundedRectangle { radius_pixels } => {
                LinuxCameraShape::RoundedRectangle {
                    radius_pixels: scale(radius_pixels, reference.0, actual.0).min(scale(
                        radius_pixels,
                        reference.1,
                        actual.1,
                    )),
                }
            }
        };
        let result = Self {
            rect: LinuxCameraRect {
                x,
                y,
                width: right.saturating_sub(x),
                height: bottom.saturating_sub(y),
            },
            shape,
            ..self
        };
        Self {
            effect: LinuxCameraEffect::None,
            ..result
        }
        .validate(actual.0, actual.1)?;
        Ok(result)
    }

    fn default_for(width: u32, height: u32) -> Self {
        let (x, y, size) = overlay_rect(width, height);
        Self {
            rect: LinuxCameraRect {
                x: x as u32,
                y: y as u32,
                width: size,
                height: size,
            },
            shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 0 },
            mirrored: false,
            effect: LinuxCameraEffect::None,
        }
    }

    fn radius(self) -> f64 {
        match self.shape {
            LinuxCameraShape::Round => f64::from(self.rect.width) / 2.0,
            LinuxCameraShape::RoundedRectangle { radius_pixels } => f64::from(radius_pixels),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxCameraBlur {
    Off,
    Light,
    Heavy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxCameraProcessing {
    pub mirrored: bool,
    pub blur: LinuxCameraBlur,
}

#[derive(Debug, Clone, Copy)]
pub struct LinuxCameraMaskReceipt {
    pub generation: u64,
    pub submitted_at: Instant,
    pub completed_at: Instant,
}

#[derive(Debug, Clone)]
pub struct LinuxProcessedCameraFrame {
    pub bgra: Arc<[u8]>,
    pub dimensions: (u32, u32),
    pub stride: usize,
    pub timestamp: Timestamp,
    pub generation: u64,
    pub processing: LinuxCameraProcessing,
    pub mask: Option<LinuxCameraMaskReceipt>,
}

pub const LINUX_CAMERA_MAX_MASK_AGE: Duration = Duration::from_millis(750);

#[derive(Clone)]
enum ProcessedCameraState {
    Pending,
    Frame(Arc<LinuxProcessedCameraFrame>),
    Failed(String),
}

pub struct LinuxCameraPublisher {
    state: tokio::sync::watch::Sender<ProcessedCameraState>,
    stop: CancellationToken,
}

impl LinuxCameraPublisher {
    pub fn is_cancelled(&self) -> bool {
        self.stop.is_cancelled()
    }

    pub fn publish(&self, frame: LinuxProcessedCameraFrame) {
        self.state.send_if_modified(|state| {
            if matches!(state, ProcessedCameraState::Failed(_)) {
                return false;
            }
            *state = ProcessedCameraState::Frame(Arc::new(frame));
            true
        });
    }

    pub fn fail(&self, error: String) {
        self.state.send_if_modified(|state| {
            if matches!(state, ProcessedCameraState::Failed(_)) {
                return false;
            }
            *state = ProcessedCameraState::Failed(error);
            true
        });
    }
}

impl Drop for LinuxCameraPublisher {
    fn drop(&mut self) {
        self.fail("Processed camera worker disconnected".to_string());
    }
}

pub struct LinuxProcessedCameraSource {
    reader: ProcessedCameraReader,
    camera_feed: Arc<CameraFeedLock>,
}

struct ProcessedCameraReader {
    state: tokio::sync::watch::Receiver<ProcessedCameraState>,
    processing: LinuxCameraProcessing,
    generation: u64,
    not_before: Instant,
    _stop: tokio_util::sync::DropGuard,
}

fn processed_camera_channel(
    processing: LinuxCameraProcessing,
    generation: u64,
    not_before: Instant,
) -> (LinuxCameraPublisher, ProcessedCameraReader) {
    let stop = CancellationToken::new();
    let (state, receiver) = tokio::sync::watch::channel(ProcessedCameraState::Pending);
    (
        LinuxCameraPublisher {
            state,
            stop: stop.clone(),
        },
        ProcessedCameraReader {
            state: receiver,
            processing,
            generation,
            not_before,
            _stop: stop.drop_guard(),
        },
    )
}

impl LinuxProcessedCameraSource {
    pub fn channel(
        camera_feed: Arc<CameraFeedLock>,
        processing: LinuxCameraProcessing,
        generation: u64,
        not_before: Instant,
    ) -> (LinuxCameraPublisher, Self) {
        let (publisher, reader) = processed_camera_channel(processing, generation, not_before);
        (
            publisher,
            Self {
                reader,
                camera_feed,
            },
        )
    }

    pub async fn wait_ready(&mut self, timeout: Duration) -> anyhow::Result<()> {
        self.reader.wait_ready(timeout).await
    }
}

impl ProcessedCameraReader {
    fn validate_current(&self) -> anyhow::Result<bool> {
        match &*self.state.borrow() {
            ProcessedCameraState::Pending => Ok(false),
            ProcessedCameraState::Failed(error) => Err(anyhow!("{error}")),
            ProcessedCameraState::Frame(frame) => {
                validate_processed_frame(
                    frame,
                    self.processing,
                    self.generation,
                    self.not_before,
                    Instant::now(),
                )?;
                Ok(true)
            }
        }
    }

    fn current(&mut self) -> anyhow::Result<Option<FFmpegVideoFrame>> {
        let state = self.state.borrow_and_update().clone();
        match state {
            ProcessedCameraState::Pending => Ok(None),
            ProcessedCameraState::Failed(error) => Err(anyhow!("{error}")),
            ProcessedCameraState::Frame(frame) => {
                validate_processed_frame(
                    &frame,
                    self.processing,
                    self.generation,
                    self.not_before,
                    Instant::now(),
                )?;
                processed_to_ffmpeg(&frame).map(Some)
            }
        }
    }

    pub async fn wait_ready(&mut self, timeout: Duration) -> anyhow::Result<()> {
        tokio::time::timeout(timeout, async {
            loop {
                if self.validate_current()? {
                    return Ok(());
                }
                self.state
                    .changed()
                    .await
                    .context("Processed camera worker disconnected")?;
            }
        })
        .await
        .context("Processed camera did not become ready before the startup deadline")?
    }
}

fn validate_processed_frame(
    frame: &LinuxProcessedCameraFrame,
    expected: LinuxCameraProcessing,
    generation: u64,
    not_before: Instant,
    now: Instant,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        frame.generation == generation,
        "Processed camera generation changed"
    );
    anyhow::ensure!(
        frame.processing == expected,
        "Processed camera effects changed"
    );
    let Timestamp::Instant(captured_at) = frame.timestamp else {
        anyhow::bail!("Processed camera requires an original monotonic capture timestamp");
    };
    anyhow::ensure!(
        captured_at >= not_before && captured_at <= now,
        "Processed camera frame predates its source lease or has a future timestamp"
    );
    anyhow::ensure!(
        camera_is_fresh(captured_at, now),
        "Processed camera frame is stale"
    );
    match (expected.blur, frame.mask) {
        (LinuxCameraBlur::Off, None) => {}
        (LinuxCameraBlur::Light | LinuxCameraBlur::Heavy, Some(mask)) => {
            anyhow::ensure!(
                mask.generation > 0
                    && mask.submitted_at >= not_before
                    && mask.submitted_at <= mask.completed_at
                    && mask.completed_at <= now,
                "Processed camera mask has invalid provenance"
            );
            anyhow::ensure!(
                now.saturating_duration_since(mask.submitted_at) <= LINUX_CAMERA_MAX_MASK_AGE,
                "Processed camera blur mask is stale"
            );
        }
        _ => anyhow::bail!("Processed camera blur was not applied as requested"),
    }
    let (width, height) = frame.dimensions;
    let row = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(4))
        .context("Processed camera row overflow")?;
    let size = frame
        .stride
        .checked_mul(height as usize)
        .context("Processed camera size overflow")?;
    anyhow::ensure!(
        width > 0 && height > 0 && frame.stride >= row && frame.bgra.len() == size,
        "Processed camera has invalid BGRA dimensions or stride"
    );
    Ok(())
}

fn processed_to_ffmpeg(frame: &LinuxProcessedCameraFrame) -> anyhow::Result<FFmpegVideoFrame> {
    let (width, height) = frame.dimensions;
    let mut inner = ffmpeg::frame::Video::new(Pixel::BGRA, width, height);
    let stride = inner.stride(0);
    let row = width as usize * 4;
    for y in 0..height as usize {
        inner.data_mut(0)[y * stride..y * stride + row]
            .copy_from_slice(&frame.bgra[y * frame.stride..y * frame.stride + row]);
    }
    Ok(FFmpegVideoFrame {
        inner,
        timestamp: frame.timestamp,
    })
}

pub(super) struct Config {
    pub(super) screen_capture: screen_capture::VideoSourceConfig,
    pub(super) camera: PreparedCamera,
}

pub(super) struct PreparedCamera {
    camera_feed: Arc<CameraFeedLock>,
    frames: PreparedCameraFrames,
}

struct PreparedCameraFrames {
    receiver: CameraReceiver,
    first: FFmpegVideoFrame,
    presentation: LinuxCameraPresentation,
}

impl PreparedCamera {
    pub(super) async fn prepare(
        camera_feed: Arc<CameraFeedLock>,
        presentation: Option<LinuxCameraPresentation>,
        processed: Option<LinuxProcessedCameraSource>,
        reference_size: Option<(u32, u32)>,
        info: VideoInfo,
    ) -> anyhow::Result<(Self, cap_timestamp::Timestamps)> {
        let mut presentation = presentation
            .unwrap_or_else(|| LinuxCameraPresentation::default_for(info.width, info.height));
        if let Some(reference) = reference_size {
            presentation = presentation.resolve(reference, (info.width, info.height))?;
        }
        let receiver = if let Some(processed) = processed {
            anyhow::ensure!(
                Arc::ptr_eq(&processed.camera_feed, &camera_feed),
                "Processed camera source belongs to a different feed lock"
            );
            anyhow::ensure!(
                presentation.mirrored == processed.reader.processing.mirrored,
                "Processed camera mirror does not match presentation"
            );
            anyhow::ensure!(
                (presentation.effect == LinuxCameraEffect::None)
                    == (processed.reader.processing.blur == LinuxCameraBlur::Off),
                "Processed camera blur does not match presentation"
            );
            presentation.mirrored = false;
            presentation.effect = LinuxCameraEffect::None;
            CameraReceiver::Processed(processed.reader)
        } else {
            let (camera_tx, camera_rx) = flume::bounded(1);
            tokio::time::timeout(
                CAMERA_ATTACH_TIMEOUT,
                camera_feed.ask(camera::AddSender(camera_tx)),
            )
            .await
            .context("Camera compositor timed out attaching to feed")?
            .map_err(|error| anyhow!("Camera compositor failed to attach to feed: {error}"))?;
            CameraReceiver::Raw(camera_rx)
        };
        let (frames, timestamps) = prepare_camera_frames(receiver, info, presentation).await?;
        Ok((
            Self {
                camera_feed,
                frames,
            },
            timestamps,
        ))
    }
}

async fn prepare_camera_frames(
    mut receiver: CameraReceiver,
    info: VideoInfo,
    presentation: LinuxCameraPresentation,
) -> anyhow::Result<(PreparedCameraFrames, cap_timestamp::Timestamps)> {
    presentation.validate(info.width, info.height)?;
    let first = receiver.first(&CancellationToken::new()).await?;
    Compositor::new(info, presentation).camera_overlay(&first.inner)?;
    // Separate Instant audio is epoch-anchored; camera readiness must not become head silence.
    let timestamps = cap_timestamp::Timestamps::now();
    Ok((
        PreparedCameraFrames {
            receiver,
            first,
            presentation,
        },
        timestamps,
    ))
}

pub(super) struct CameraCompositeSource {
    inner: screen_capture::VideoSource,
    info: VideoInfo,
    _camera_feed: Arc<CameraFeedLock>,
    _compositor_stop: tokio_util::sync::DropGuard,
}

impl VideoSource for CameraCompositeSource {
    type Config = Config;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self> {
        let stop_token = ctx.stop_token().child_token();
        let compositor_stop = stop_token.clone().drop_guard();
        let info = config.screen_capture.video_info();
        let PreparedCamera {
            camera_feed,
            frames,
        } = config.camera;
        let PreparedCameraFrames {
            receiver: camera_rx,
            first: first_camera,
            presentation,
        } = frames;
        validate_camera_frame(&first_camera, Instant::now())?;
        let (screen_tx, screen_rx) = mpsc::channel(SCREEN_CHANNEL_CAPACITY);
        let inner = screen_capture::VideoSource::setup(config.screen_capture, screen_tx, ctx)
            .await
            .context("screen source setup for camera compositor")?;
        let health_tx = ctx.health_tx().clone();
        let runtime = tokio::runtime::Handle::current();
        ctx.tasks()
            .spawn_thread("linux-instant-camera-compositor", move || {
                let _runtime = runtime.enter();
                compositor_thread(
                    screen_rx,
                    camera_rx,
                    video_tx,
                    stop_token,
                    health_tx,
                    Compositor::new(info, presentation),
                    first_camera,
                )
            });
        Ok(Self {
            inner,
            info,
            _camera_feed: camera_feed,
            _compositor_stop: compositor_stop,
        })
    }

    fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        self.inner.start()
    }

    fn video_info(&self) -> VideoInfo {
        self.info
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        self.inner.stop()
    }
}

enum CameraReceiver {
    Raw(flume::Receiver<FFmpegVideoFrame>),
    Processed(ProcessedCameraReader),
}

impl CameraReceiver {
    async fn first(&mut self, stop: &CancellationToken) -> anyhow::Result<FFmpegVideoFrame> {
        match self {
            Self::Raw(rx) => first_camera_frame(rx, stop, CAMERA_ATTACH_TIMEOUT).await,
            Self::Processed(source) => {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => anyhow::bail!("Camera compositor startup cancelled"),
                    ready = source.wait_ready(CAMERA_ATTACH_TIMEOUT) => ready?,
                }
                source
                    .current()?
                    .context("Processed camera first frame missing")
            }
        }
    }

    async fn recv(&mut self) -> anyhow::Result<FFmpegVideoFrame> {
        match self {
            Self::Raw(rx) => rx
                .recv_async()
                .await
                .context("Required camera disconnected"),
            Self::Processed(source) => loop {
                source
                    .state
                    .changed()
                    .await
                    .context("Processed camera worker disconnected")?;
                if let Some(frame) = source.current()? {
                    return Ok(frame);
                }
            },
        }
    }

    fn latest(&mut self) -> anyhow::Result<Option<FFmpegVideoFrame>> {
        match self {
            Self::Raw(rx) => match rx.try_recv() {
                Ok(frame) => Ok(Some(frame)),
                Err(flume::TryRecvError::Empty) => Ok(None),
                Err(flume::TryRecvError::Disconnected) => {
                    anyhow::bail!("Required camera disconnected")
                }
            },
            Self::Processed(source) => {
                if source
                    .state
                    .has_changed()
                    .context("Processed camera worker disconnected")?
                {
                    source.current()
                } else {
                    source.validate_current()?;
                    Ok(None)
                }
            }
        }
    }
}

async fn first_camera_frame(
    camera_rx: &flume::Receiver<FFmpegVideoFrame>,
    stop_token: &CancellationToken,
    timeout: Duration,
) -> anyhow::Result<FFmpegVideoFrame> {
    tokio::select! {
        biased;
        _ = stop_token.cancelled() => anyhow::bail!("Camera compositor startup cancelled"),
        received = tokio::time::timeout(timeout, camera_rx.recv_async()) => {
            let frame = received.context("Camera did not deliver its first frame before the startup deadline")?
                .context("Camera disconnected before its first frame")?;
            validate_camera_frame(&frame, Instant::now())?;
            Ok(frame)
        }
    }
}

fn validate_camera_frame(frame: &FFmpegVideoFrame, now: Instant) -> anyhow::Result<()> {
    if frame.inner.width() == 0 || frame.inner.height() == 0 || frame.inner.planes() == 0 {
        anyhow::bail!("Camera delivered an invalid frame");
    }
    if !camera_is_fresh(camera_freshness_anchor(frame, now), now) {
        anyhow::bail!("Camera frame exceeded the freshness deadline");
    }
    Ok(())
}

fn compositor_thread(
    screen_rx: mpsc::Receiver<FFmpegVideoFrame>,
    mut camera_rx: CameraReceiver,
    mut video_tx: mpsc::Sender<FFmpegVideoFrame>,
    stop_token: CancellationToken,
    health_tx: output_pipeline::HealthSender,
    mut compositor: Compositor,
    first_camera: FFmpegVideoFrame,
) -> anyhow::Result<()> {
    let result = futures::executor::block_on(async {
        let mut screen_rx = screen_rx.fuse();
        let mut latest_camera = first_camera;
        let mut freshness_anchor = camera_freshness_anchor(&latest_camera, Instant::now());
        loop {
            enum Event {
                Stop,
                Stale,
                Camera(anyhow::Result<FFmpegVideoFrame>),
                Screen(Option<FFmpegVideoFrame>),
            }
            let event = {
                let stop = stop_token.cancelled().fuse();
                let camera = camera_rx.recv().fuse();
                let screen = screen_rx.next().fuse();
                let remaining = CAMERA_STALE_AFTER.saturating_sub(freshness_anchor.elapsed());
                let stale = tokio::time::sleep(remaining).fuse();
                futures::pin_mut!(stop, camera, screen, stale);
                futures::select_biased! {
                    _ = stop => Event::Stop,
                    _ = stale => Event::Stale,
                    result = camera => Event::Camera(result),
                    result = screen => Event::Screen(result),
                }
            };
            match event {
                Event::Stop | Event::Screen(None) => break,
                Event::Stale => anyhow::bail!("Required camera stopped delivering fresh frames"),
                Event::Camera(frame) => {
                    latest_camera = frame?;
                    validate_camera_frame(&latest_camera, Instant::now())?;
                    freshness_anchor = camera_freshness_anchor(&latest_camera, Instant::now());
                }
                Event::Screen(Some(screen)) => {
                    if let Some(frame) = camera_rx.latest()? {
                        latest_camera = frame;
                        freshness_anchor = camera_freshness_anchor(&latest_camera, Instant::now());
                    }
                    validate_camera_frame(&latest_camera, Instant::now())?;
                    let output = compositor
                        .compose(&screen, &latest_camera)
                        .context("Required camera composition failed")?;
                    if stop_token.is_cancelled() {
                        break;
                    }
                    if matches!(
                        send_with_stall_budget_futures(
                            &mut video_tx,
                            output,
                            "linux-instant-camera-compositor",
                            &health_tx,
                        ),
                        StallSendOutcome::Disconnected
                    ) {
                        break;
                    }
                }
            }
        }
        Ok(())
    });
    if result.is_err() {
        output_pipeline::emit_health(
            &health_tx,
            output_pipeline::PipelineHealthEvent::DeviceLost {
                subsystem: "camera-compositor".to_string(),
            },
        );
    }
    result
}

fn camera_is_fresh(received_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(received_at) <= CAMERA_STALE_AFTER
}

fn camera_freshness_anchor(frame: &FFmpegVideoFrame, received_at: Instant) -> Instant {
    match frame.timestamp {
        Timestamp::Instant(captured_at) => captured_at,
        _ => received_at,
    }
}

struct Compositor {
    info: VideoInfo,
    presentation: LinuxCameraPresentation,
    screen_to_rgba: Option<RgbaConverter>,
    camera_to_rgba: Option<RgbaConverter>,
    rgba_to_screen: Option<RgbaConverter>,
}

impl Compositor {
    fn new(info: VideoInfo, presentation: LinuxCameraPresentation) -> Self {
        Self {
            info,
            presentation,
            screen_to_rgba: None,
            camera_to_rgba: None,
            rgba_to_screen: None,
        }
    }

    fn compose(
        &mut self,
        screen: &FFmpegVideoFrame,
        camera: &FFmpegVideoFrame,
    ) -> anyhow::Result<FFmpegVideoFrame> {
        let screen_rgba = self.convert_screen(&screen.inner)?;
        self.presentation
            .validate(self.info.width, self.info.height)?;
        let camera_overlay = self.camera_overlay(&camera.inner)?;
        let mut composed = screen_rgba;
        blend_rgba(
            &mut composed,
            &camera_overlay,
            self.presentation.rect.x as usize,
            self.presentation.rect.y as usize,
        )?;
        let mut output = self.convert_to_screen(&composed)?;
        output.set_pts(screen.inner.pts());

        Ok(FFmpegVideoFrame {
            inner: output,
            timestamp: screen.timestamp,
        })
    }

    fn camera_overlay(
        &mut self,
        input: &ffmpeg::frame::Video,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        let rect = self.presentation.rect;
        let rgba = self.convert_camera(input, rect.width, rect.height)?;
        crop_camera(&rgba, self.presentation)
    }

    fn convert_screen(
        &mut self,
        input: &ffmpeg::frame::Video,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        let needs_converter = self.screen_to_rgba.as_ref().is_none_or(|converter| {
            converter.source_format != input.format()
                || converter.source_width != input.width()
                || converter.source_height != input.height()
        });
        if needs_converter {
            self.screen_to_rgba = Some(RgbaConverter::new(
                input.format(),
                input.width(),
                input.height(),
                Pixel::RGBA,
                self.info.width,
                self.info.height,
            )?);
        }
        self.screen_to_rgba
            .as_mut()
            .expect("screen converter initialized")
            .convert(input)
    }

    fn convert_camera(
        &mut self,
        input: &ffmpeg::frame::Video,
        width: u32,
        height: u32,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        let (destination_width, destination_height) =
            aspect_fill_dimensions(input.width(), input.height(), width, height)?;
        let needs_converter = self.camera_to_rgba.as_ref().is_none_or(|converter| {
            converter.source_format != input.format()
                || converter.source_width != input.width()
                || converter.source_height != input.height()
                || converter.destination_width != destination_width
                || converter.destination_height != destination_height
        });
        if needs_converter {
            self.camera_to_rgba = Some(RgbaConverter::new(
                input.format(),
                input.width(),
                input.height(),
                Pixel::RGBA,
                destination_width,
                destination_height,
            )?);
        }
        self.camera_to_rgba
            .as_mut()
            .expect("camera converter initialized")
            .convert(input)
    }

    fn convert_to_screen(
        &mut self,
        input: &ffmpeg::frame::Video,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        if self.rgba_to_screen.is_none() {
            self.rgba_to_screen = Some(RgbaConverter::new(
                Pixel::RGBA,
                self.info.width,
                self.info.height,
                self.info.pixel_format,
                self.info.width,
                self.info.height,
            )?);
        }
        self.rgba_to_screen
            .as_mut()
            .expect("screen output converter initialized")
            .convert(input)
    }
}

struct RgbaConverter {
    context: ffmpeg::software::scaling::Context,
    source_format: ffmpeg::format::Pixel,
    source_width: u32,
    source_height: u32,
    destination_format: ffmpeg::format::Pixel,
    destination_width: u32,
    destination_height: u32,
}

impl RgbaConverter {
    fn new(
        source_format: ffmpeg::format::Pixel,
        source_width: u32,
        source_height: u32,
        destination_format: ffmpeg::format::Pixel,
        destination_width: u32,
        destination_height: u32,
    ) -> anyhow::Result<Self> {
        if source_width == 0
            || source_height == 0
            || destination_width == 0
            || destination_height == 0
        {
            return Err(anyhow!("invalid video dimensions for compositor"));
        }
        let context = ffmpeg::software::scaling::Context::get(
            source_format,
            source_width,
            source_height,
            destination_format,
            destination_width,
            destination_height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )?;
        Ok(Self {
            context,
            source_format,
            source_width,
            source_height,
            destination_format,
            destination_width,
            destination_height,
        })
    }

    fn convert(&mut self, input: &ffmpeg::frame::Video) -> anyhow::Result<ffmpeg::frame::Video> {
        if self.source_format != input.format()
            || self.source_width != input.width()
            || self.source_height != input.height()
        {
            let destination_format = self.destination_format;
            let destination_width = self.destination_width;
            let destination_height = self.destination_height;
            *self = Self::new(
                input.format(),
                input.width(),
                input.height(),
                destination_format,
                destination_width,
                destination_height,
            )?;
        }
        let mut output = ffmpeg::frame::Video::empty();
        self.context.run(input, &mut output)?;
        output.set_pts(input.pts());
        Ok(output)
    }
}

fn overlay_rect(width: u32, height: u32) -> (usize, usize, u32) {
    if width == 0 || height == 0 {
        return (0, 0, 0);
    }
    let short = width.min(height);
    let size = ((u64::from(short) * 30) / 100).clamp(1, u64::from(short)) as u32;
    let margin = (u64::from(short) * 2 / 100) as u32;
    let x = width.saturating_sub(size.saturating_add(margin));
    let y = height.saturating_sub(size.saturating_add(margin));
    (x as usize, y as usize, size)
}

fn aspect_fill_dimensions(
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
) -> anyhow::Result<(u32, u32)> {
    if width == 0 || height == 0 || target_width == 0 || target_height == 0 {
        return Err(anyhow!("invalid dimensions for camera scaling"));
    }
    if u64::from(width) * u64::from(target_height) >= u64::from(height) * u64::from(target_width) {
        let scaled = (u64::from(target_height) * u64::from(width)).div_ceil(u64::from(height));
        Ok((
            u32::try_from(scaled).context("Camera scaling exceeds supported width")?,
            target_height,
        ))
    } else {
        let scaled = (u64::from(target_width) * u64::from(height)).div_ceil(u64::from(width));
        Ok((
            target_width,
            u32::try_from(scaled).context("Camera scaling exceeds supported height")?,
        ))
    }
}

fn crop_camera(
    source: &ffmpeg::frame::Video,
    presentation: LinuxCameraPresentation,
) -> anyhow::Result<ffmpeg::frame::Video> {
    let rect = presentation.rect;
    if source.format() != Pixel::RGBA
        || rect.width == 0
        || rect.height == 0
        || source.width() < rect.width
        || source.height() < rect.height
    {
        anyhow::bail!("Scaled camera frame is smaller than its presentation");
    }
    let crop_x = (source.width() - rect.width) as usize / 2;
    let crop_y = (source.height() - rect.height) as usize / 2;
    let mut output = ffmpeg::frame::Video::new(Pixel::RGBA, rect.width, rect.height);
    let source_stride = source.stride(0);
    let output_stride = output.stride(0);
    let source_data = source.data(0);
    let output_data = output.data_mut(0);
    let radius = presentation.radius();
    for y in 0..rect.height as usize {
        for x in 0..rect.width as usize {
            let source_x = crop_x
                + if presentation.mirrored {
                    rect.width as usize - 1 - x
                } else {
                    x
                };
            let source_offset = (crop_y + y) * source_stride + source_x * 4;
            let output_offset = y * output_stride + x * 4;
            let source_pixel = source_data
                .get(source_offset..source_offset + 4)
                .context("RGBA camera frame layout is smaller than dimensions")?;
            let destination = output_data
                .get_mut(output_offset..output_offset + 4)
                .context("RGBA camera output layout is smaller than dimensions")?;
            destination.copy_from_slice(source_pixel);
            if radius > 0.0 {
                let px = x as f64 + 0.5;
                let py = y as f64 + 0.5;
                let dx = px - px.clamp(radius, f64::from(rect.width) - radius);
                let dy = py - py.clamp(radius, f64::from(rect.height) - radius);
                let coverage = (radius + 0.5 - dx.hypot(dy)).clamp(0.0, 1.0);
                destination[3] = (f64::from(destination[3]) * coverage).round() as u8;
            }
        }
    }
    output.set_pts(source.pts());
    Ok(output)
}

fn blend_rgba(
    destination: &mut ffmpeg::frame::Video,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
) -> anyhow::Result<()> {
    if destination.format() != ffmpeg::format::Pixel::RGBA
        || source.format() != ffmpeg::format::Pixel::RGBA
    {
        return Err(anyhow!("RGBA blend requires RGBA frames"));
    }
    let destination_stride = destination.stride(0);
    let source_stride = source.stride(0);
    let destination_width = destination.width() as usize;
    let destination_height = destination.height() as usize;
    let source_width = source.width() as usize;
    let source_height = source.height() as usize;
    if x.saturating_add(source_width) > destination_width
        || y.saturating_add(source_height) > destination_height
    {
        return Err(anyhow!("camera overlay exceeds screen frame"));
    }
    let source_data = source.data(0);
    let destination_data = destination.data_mut(0);
    for row in 0..source_height {
        for column in 0..source_width {
            let source_offset = row * source_stride + column * 4;
            let destination_offset = (y + row) * destination_stride + (x + column) * 4;
            let alpha = u16::from(source_data[source_offset + 3]);
            let inverse_alpha = 255 - alpha;
            for channel in 0..3 {
                destination_data[destination_offset + channel] =
                    ((u16::from(source_data[source_offset + channel]) * alpha
                        + u16::from(destination_data[destination_offset + channel])
                            * inverse_alpha
                        + 127)
                        / 255) as u8;
            }
            destination_data[destination_offset + 3] = 255;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::SinkExt;

    #[tokio::test]
    async fn prepared_camera_epoch_excludes_delayed_raw_readiness() {
        ffmpeg::init().unwrap();
        for delay in [
            Duration::ZERO,
            Duration::from_millis(25),
            Duration::from_millis(800),
        ] {
            let previous_epoch = cap_timestamp::Timestamps::now();
            let (sender, receiver) = flume::bounded(1);
            let prepare = prepare_camera_frames(
                CameraReceiver::Raw(receiver),
                VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
                presentation(4, 4),
            );
            let deliver = async {
                tokio::time::sleep(delay).await;
                let frame = camera_frame();
                let Timestamp::Instant(captured_at) = frame.timestamp else {
                    panic!("monotonic fixture")
                };
                sender.send_async(frame).await.unwrap();
                captured_at
            };
            let (prepared, captured_at) = tokio::join!(prepare, deliver);
            let (frames, epoch) = prepared.unwrap();
            assert!(epoch.instant() >= captured_at);
            assert!(
                epoch
                    .instant()
                    .saturating_duration_since(previous_epoch.instant())
                    >= delay
            );
            assert!(
                matches!(frames.first.timestamp, Timestamp::Instant(value) if value == captured_at)
            );
            let marker = Timestamp::Instant(epoch.instant() + Duration::from_millis(250));
            assert_eq!(marker.signed_duration_since_secs(epoch), 0.25);
            assert!(
                marker.signed_duration_since_secs(previous_epoch) >= delay.as_secs_f64() + 0.25
            );
            assert!(!sender.is_disconnected());
            drop(frames);
            assert!(sender.is_disconnected());
        }
    }

    #[tokio::test]
    async fn prepared_camera_epoch_excludes_pending_processed_readiness() {
        ffmpeg::init().unwrap();
        let not_before = Instant::now();
        let processing = processed_frame(not_before, 11).processing;
        let (publisher, reader) = processed_camera_channel(processing, 11, not_before);
        let prepare = prepare_camera_frames(
            CameraReceiver::Processed(reader),
            VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
            presentation(4, 4),
        );
        let deliver = async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let captured_at = Instant::now();
            publisher.publish(processed_frame(captured_at, 11));
            captured_at
        };
        let (prepared, captured_at) = tokio::join!(prepare, deliver);
        let (frames, epoch) = prepared.unwrap();
        assert!(epoch.instant() >= captured_at);
        assert!(
            matches!(frames.first.timestamp, Timestamp::Instant(value) if value == captured_at)
        );
        let late_audio = Timestamp::Instant(epoch.instant() + Duration::from_millis(2500));
        assert_eq!(late_audio.signed_duration_since_secs(epoch), 2.5);
        assert!(!publisher.is_cancelled());
        drop(frames);
        assert!(publisher.is_cancelled());
    }

    #[tokio::test]
    async fn prepared_camera_failure_returns_no_epoch_and_releases_receiver() {
        ffmpeg::init().unwrap();
        let (sender, receiver) = flume::bounded(1);
        sender
            .send(FFmpegVideoFrame {
                inner: ffmpeg::frame::Video::empty(),
                timestamp: Timestamp::Instant(Instant::now()),
            })
            .unwrap();
        assert!(
            prepare_camera_frames(
                CameraReceiver::Raw(receiver),
                VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
                presentation(4, 4),
            )
            .await
            .is_err()
        );
        assert!(sender.is_disconnected());

        let now = Instant::now();
        let processing = processed_frame(now, 12).processing;
        let (publisher, reader) = processed_camera_channel(processing, 12, now);
        publisher.fail("Required blur failed".to_string());
        let error = prepare_camera_frames(
            CameraReceiver::Processed(reader),
            VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
            presentation(4, 4),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("Required blur failed"));
        assert!(publisher.is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_camera_preparation_releases_raw_and_processed_inputs() {
        let (sender, receiver) = flume::bounded(1);
        let preparation = prepare_camera_frames(
            CameraReceiver::Raw(receiver),
            VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
            presentation(4, 4),
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), preparation)
                .await
                .is_err()
        );
        assert!(sender.is_disconnected());

        let now = Instant::now();
        let processing = processed_frame(now, 13).processing;
        let (publisher, reader) = processed_camera_channel(processing, 13, now);
        let preparation = prepare_camera_frames(
            CameraReceiver::Processed(reader),
            VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
            presentation(4, 4),
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), preparation)
                .await
                .is_err()
        );
        assert!(publisher.is_cancelled());
    }

    #[tokio::test]
    async fn prepared_camera_rejects_geometry_before_creating_epoch() {
        let (sender, receiver) = flume::bounded(1);
        assert!(
            prepare_camera_frames(
                CameraReceiver::Raw(receiver),
                VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
                presentation(5, 4),
            )
            .await
            .is_err()
        );
        assert!(sender.is_disconnected());
    }

    fn processed_frame(now: Instant, generation: u64) -> LinuxProcessedCameraFrame {
        LinuxProcessedCameraFrame {
            bgra: Arc::from([
                10, 20, 30, 255, 40, 50, 60, 255, 99, 99, 99, 99, 70, 80, 90, 255, 100, 110, 120,
                255, 99, 99, 99, 99,
            ]),
            dimensions: (2, 2),
            stride: 12,
            timestamp: Timestamp::Instant(now),
            generation,
            processing: LinuxCameraProcessing {
                mirrored: true,
                blur: LinuxCameraBlur::Off,
            },
            mask: None,
        }
    }

    #[test]
    fn processed_bgra_stride_and_original_timestamp_are_preserved_without_second_mirror() {
        ffmpeg::init().unwrap();
        let now = Instant::now();
        let frame = processed_frame(now, 7);
        validate_processed_frame(&frame, frame.processing, 7, now, now).unwrap();
        let converted = processed_to_ffmpeg(&frame).unwrap();
        assert_eq!(converted.inner.format(), Pixel::BGRA);
        assert_eq!(&converted.inner.data(0)[..8], &frame.bgra[..8]);
        assert_eq!(
            &converted.inner.data(0)[converted.inner.stride(0)..][..8],
            &frame.bgra[12..20]
        );
        assert!(matches!(converted.timestamp, Timestamp::Instant(timestamp) if timestamp == now));
        let mut compositor = Compositor::new(
            VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 2, 2, 30),
            presentation(2, 2),
        );
        let overlay = compositor.camera_overlay(&converted.inner).unwrap();
        assert_eq!(overlay.format(), Pixel::RGBA);
        assert_eq!(&overlay.data(0)[..8], &[30, 20, 10, 255, 60, 50, 40, 255]);
        assert_eq!(
            &overlay.data(0)[overlay.stride(0)..][..8],
            &[90, 80, 70, 255, 120, 110, 100, 255]
        );
    }

    #[test]
    fn processed_frame_rejects_old_selection_generation_timestamp_and_effects() {
        let now = Instant::now();
        let frame = processed_frame(now, 7);
        assert!(validate_processed_frame(&frame, frame.processing, 8, now, now).is_err());
        assert!(
            validate_processed_frame(
                &frame,
                frame.processing,
                7,
                now + Duration::from_nanos(1),
                now + Duration::from_nanos(1)
            )
            .is_err()
        );
        assert!(
            validate_processed_frame(
                &frame,
                LinuxCameraProcessing {
                    mirrored: false,
                    ..frame.processing
                },
                7,
                now,
                now
            )
            .is_err()
        );
        assert!(
            validate_processed_frame(
                &frame,
                frame.processing,
                7,
                now,
                now + CAMERA_STALE_AFTER + Duration::from_nanos(1)
            )
            .is_err()
        );
        let mut invalid = frame.clone();
        invalid.stride = 7;
        assert!(validate_processed_frame(&invalid, frame.processing, 7, now, now).is_err());
        invalid = frame.clone();
        invalid.bgra = Arc::from([0u8; 23]);
        assert!(validate_processed_frame(&invalid, frame.processing, 7, now, now).is_err());
        invalid = frame.clone();
        invalid.timestamp = Timestamp::SystemTime(std::time::SystemTime::now());
        assert!(validate_processed_frame(&invalid, frame.processing, 7, now, now).is_err());
    }

    #[test]
    fn processed_blur_requires_exact_mode_and_fresh_real_mask() {
        let now = Instant::now();
        let mut frame = processed_frame(now, 7);
        frame.processing.blur = LinuxCameraBlur::Light;
        assert!(validate_processed_frame(&frame, frame.processing, 7, now, now).is_err());
        frame.mask = Some(LinuxCameraMaskReceipt {
            generation: 1,
            submitted_at: now,
            completed_at: now,
        });
        assert!(validate_processed_frame(&frame, frame.processing, 7, now, now).is_ok());
        assert!(
            validate_processed_frame(
                &frame,
                LinuxCameraProcessing {
                    blur: LinuxCameraBlur::Heavy,
                    ..frame.processing
                },
                7,
                now,
                now
            )
            .is_err()
        );
        assert!(
            validate_processed_frame(
                &frame,
                frame.processing,
                7,
                now,
                now + LINUX_CAMERA_MAX_MASK_AGE + Duration::from_millis(1)
            )
            .is_err()
        );
        frame.mask.as_mut().unwrap().generation = 0;
        assert!(validate_processed_frame(&frame, frame.processing, 7, now, now).is_err());
    }

    #[tokio::test]
    async fn processed_latest_channel_has_sticky_error_and_wakes_waiter() {
        let now = Instant::now();
        let frame = processed_frame(now, 7);
        let (publisher, mut reader) = processed_camera_channel(frame.processing, 7, now);
        assert!(!reader.validate_current().unwrap());
        publisher.publish(frame.clone());
        reader.wait_ready(Duration::from_millis(20)).await.unwrap();
        publisher.fail("inference failed".to_string());
        publisher.publish(frame);
        let error = reader
            .wait_ready(Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("inference failed"));
        assert!(matches!(
            &*reader.state.borrow(),
            ProcessedCameraState::Failed(_)
        ));
        let (_, mut pending) = processed_camera_channel(reader.processing, 8, now);
        assert!(pending.wait_ready(Duration::from_millis(20)).await.is_err());
    }

    #[tokio::test]
    async fn processed_first_frame_failure_timeout_and_publisher_drop_are_explicit() {
        let now = Instant::now();
        let processing = processed_frame(now, 1).processing;
        let (publisher, mut reader) = processed_camera_channel(processing, 1, now);
        assert!(
            reader
                .wait_ready(Duration::from_millis(1))
                .await
                .unwrap_err()
                .to_string()
                .contains("deadline")
        );
        publisher.fail("first mask inference failed".to_string());
        assert!(
            reader
                .wait_ready(Duration::from_secs(1))
                .await
                .unwrap_err()
                .to_string()
                .contains("first mask")
        );
        let (publisher, mut reader) = processed_camera_channel(processing, 2, now);
        drop(publisher);
        assert!(
            reader
                .wait_ready(Duration::from_secs(1))
                .await
                .unwrap_err()
                .to_string()
                .contains("disconnected")
        );
    }

    #[test]
    fn processed_drop_cancels_only_its_attempt_and_restart_has_fresh_state() {
        let now = Instant::now();
        let processing = processed_frame(now, 1).processing;
        let (old_publisher, old_reader) = processed_camera_channel(processing, 1, now);
        let (new_publisher, new_reader) = processed_camera_channel(processing, 2, now);
        drop(old_reader);
        assert!(old_publisher.is_cancelled());
        assert!(!new_publisher.is_cancelled());
        old_publisher.publish(processed_frame(now, 1));
        assert!(!new_reader.validate_current().unwrap());
        new_publisher.publish(processed_frame(now, 2));
        assert!(new_reader.validate_current().unwrap());
    }

    #[tokio::test]
    async fn processed_required_error_reaches_compositor_completion_without_screen_success() {
        ffmpeg::init().unwrap();
        let now = Instant::now();
        let frame = processed_frame(now, 3);
        let (publisher, reader) = processed_camera_channel(frame.processing, 3, now);
        publisher.publish(frame.clone());
        publisher.fail("required blur stopped".to_string());
        let (mut screen, screen_rx) = mpsc::channel(1);
        let (video_tx, mut output) = mpsc::channel(1);
        let (health_tx, _health_rx) = tokio::sync::mpsc::channel(4);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let _runtime = runtime.enter();
            let result = compositor_thread(
                screen_rx,
                CameraReceiver::Processed(reader),
                video_tx,
                CancellationToken::new(),
                health_tx,
                Compositor::new(
                    VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30),
                    presentation(2, 2),
                ),
                processed_to_ffmpeg(&frame).unwrap(),
            );
            let _ = done_tx.send(result);
        });
        let _ = screen.send(camera_frame()).await;
        let result = tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("required blur stopped")
        );
        assert!(output.next().await.is_none());
    }

    #[test]
    fn round_mapping_preserves_one_pixel_nonsquare_footprint_with_maximum_radius() {
        let request = LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: 0,
                y: 0,
                width: 401,
                height: 401,
            },
            shape: LinuxCameraShape::Round,
            mirrored: false,
            effect: LinuxCameraEffect::None,
        };
        let mapped = request.resolve((801, 600), (800, 600)).unwrap();
        assert_eq!(
            mapped.rect,
            LinuxCameraRect {
                x: 0,
                y: 0,
                width: 400,
                height: 401
            }
        );
        assert_eq!(
            mapped.shape,
            LinuxCameraShape::RoundedRectangle { radius_pixels: 200 }
        );
        assert!(request.resolve((801, 600), (600, 600)).is_err());
    }

    #[test]
    fn presentation_reference_mapping_resolves_odd_capture_dimensions_once() {
        let request = LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: 11,
                y: 13,
                width: 101,
                height: 81,
            },
            shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 10 },
            mirrored: true,
            effect: LinuxCameraEffect::BackgroundBlur,
        };
        let mapped = request.resolve((801, 601), (800, 600)).unwrap();
        assert_eq!(mapped.rect, request.rect);
        assert_eq!(mapped.effect, LinuxCameraEffect::BackgroundBlur);
        let half = request.resolve((802, 602), (401, 301)).unwrap();
        assert_eq!(
            half.rect,
            LinuxCameraRect {
                x: 6,
                y: 7,
                width: 50,
                height: 40
            }
        );
        assert_eq!(
            half.shape,
            LinuxCameraShape::RoundedRectangle { radius_pixels: 5 }
        );
        assert!(request.resolve((0, 601), (800, 600)).is_err());
    }

    fn presentation(width: u32, height: u32) -> LinuxCameraPresentation {
        LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: 0,
                y: 0,
                width,
                height,
            },
            shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 0 },
            mirrored: false,
            effect: LinuxCameraEffect::None,
        }
    }

    fn camera_frame() -> FFmpegVideoFrame {
        let mut inner = ffmpeg::frame::Video::new(Pixel::RGBA, 4, 4);
        for pixel in inner.data_mut(0).chunks_exact_mut(4) {
            pixel.copy_from_slice(&[200, 10, 20, 255]);
        }
        FFmpegVideoFrame {
            inner,
            timestamp: Timestamp::Instant(Instant::now()),
        }
    }

    #[test]
    fn presentation_rejects_empty_overflow_outside_shape_radius_and_unsupported_effect() {
        let mut request = presentation(8, 4);
        assert_eq!(request.validate(8, 4), Ok(()));
        request.rect.x = u32::MAX;
        assert_eq!(
            request.validate(8, 4),
            Err(LinuxCameraPresentationError::OutsideCapture)
        );
        request.rect.x = 1;
        assert_eq!(
            request.validate(8, 4),
            Err(LinuxCameraPresentationError::OutsideCapture)
        );
        request.rect.x = 0;
        request.shape = LinuxCameraShape::Round;
        assert_eq!(
            request.validate(8, 4),
            Err(LinuxCameraPresentationError::NonSquareCircle)
        );
        request.shape = LinuxCameraShape::RoundedRectangle { radius_pixels: 3 };
        assert_eq!(
            request.validate(8, 4),
            Err(LinuxCameraPresentationError::InvalidRadius)
        );
        request.shape = LinuxCameraShape::RoundedRectangle { radius_pixels: 2 };
        request.effect = LinuxCameraEffect::BackgroundBlur;
        assert_eq!(
            request.validate(8, 4),
            Err(LinuxCameraPresentationError::UnsupportedEffect)
        );
        request.rect.width = 0;
        assert_eq!(
            request.validate(8, 4),
            Err(LinuxCameraPresentationError::EmptyDimensions)
        );
    }

    #[test]
    fn rectangular_cover_crop_preserves_aspect_and_rejects_scaling_overflow() {
        assert_eq!(
            aspect_fill_dimensions(640, 480, 160, 90).unwrap(),
            (160, 120)
        );
        assert_eq!(
            aspect_fill_dimensions(1920, 1080, 90, 160).unwrap(),
            (285, 160)
        );
        assert!(aspect_fill_dimensions(u32::MAX, 1, 1, u32::MAX).is_err());
        assert!(aspect_fill_dimensions(0, 10, 1, 1).is_err());
    }

    #[test]
    fn mirror_changes_only_presentation_pixels_not_raw_camera() {
        ffmpeg::init().unwrap();
        let mut frame = ffmpeg::frame::Video::new(Pixel::RGBA, 4, 2);
        let stride = frame.stride(0);
        for y in 0..2 {
            for x in 0..4 {
                frame.data_mut(0)[y * stride + x * 4..][..4]
                    .copy_from_slice(&[x as u8, y as u8, 3, 255]);
            }
        }
        let before = frame.data(0).to_vec();
        let mut request = presentation(4, 2);
        request.mirrored = true;
        let output = crop_camera(&frame, request).unwrap();
        assert_eq!(&output.data(0)[..4], &[3, 0, 3, 255]);
        assert_eq!(&output.data(0)[12..16], &[0, 0, 3, 255]);
        assert_eq!(frame.data(0), before);
    }

    #[test]
    fn round_and_rounded_rectangle_mask_corners_without_masking_center() {
        ffmpeg::init().unwrap();
        let mut frame = ffmpeg::frame::Video::new(Pixel::RGBA, 8, 8);
        frame.data_mut(0).fill(255);
        for shape in [
            LinuxCameraShape::Round,
            LinuxCameraShape::RoundedRectangle { radius_pixels: 3 },
        ] {
            let output = crop_camera(
                &frame,
                LinuxCameraPresentation {
                    shape,
                    ..presentation(8, 8)
                },
            )
            .unwrap();
            assert_eq!(output.data(0)[3], 0);
            assert_eq!(output.data(0)[output.stride(0) * 4 + 4 * 4 + 3], 255);
        }
    }

    #[tokio::test]
    async fn first_camera_readiness_requires_fresh_valid_frame() {
        ffmpeg::init().unwrap();
        let (tx, rx) = flume::bounded(1);
        assert!(tx.send(camera_frame()).is_ok());
        assert!(
            first_camera_frame(&rx, &CancellationToken::new(), Duration::from_millis(20))
                .await
                .is_ok()
        );
        let mut stale = camera_frame();
        stale.timestamp =
            Timestamp::Instant(Instant::now().checked_sub(Duration::from_secs(2)).unwrap());
        assert!(tx.send(stale).is_ok());
        assert!(
            first_camera_frame(&rx, &CancellationToken::new(), Duration::from_millis(20))
                .await
                .is_err()
        );
        assert!(
            tx.send(FFmpegVideoFrame {
                inner: ffmpeg::frame::Video::empty(),
                timestamp: Timestamp::Instant(Instant::now()),
            })
            .is_ok()
        );
        assert!(
            first_camera_frame(&rx, &CancellationToken::new(), Duration::from_millis(20))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn first_camera_readiness_times_out_or_reports_disconnect() {
        let (tx, rx) = flume::bounded(1);
        assert!(
            first_camera_frame(&rx, &CancellationToken::new(), Duration::from_millis(10))
                .await
                .err()
                .expect("camera readiness failed")
                .to_string()
                .contains("deadline")
        );
        drop(tx);
        assert!(
            first_camera_frame(&rx, &CancellationToken::new(), Duration::from_millis(20))
                .await
                .err()
                .expect("camera readiness failed")
                .to_string()
                .contains("disconnected")
        );
    }

    #[tokio::test]
    async fn first_camera_readiness_prefers_stop_even_when_frame_ready() {
        ffmpeg::init().unwrap();
        let (tx, rx) = flume::bounded(1);
        assert!(tx.send(camera_frame()).is_ok());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            first_camera_frame(&rx, &cancel, Duration::from_secs(1))
                .await
                .err()
                .expect("camera readiness failed")
                .to_string()
                .contains("cancelled")
        );
        assert_eq!(rx.len(), 1);
    }

    struct TestCompositor {
        screen: mpsc::Sender<FFmpegVideoFrame>,
        camera: flume::Sender<FFmpegVideoFrame>,
        output: mpsc::Receiver<FFmpegVideoFrame>,
        done: tokio::sync::oneshot::Receiver<anyhow::Result<()>>,
        stop: CancellationToken,
    }

    fn start_test_compositor(first_camera: FFmpegVideoFrame) -> TestCompositor {
        let (screen, screen_rx) = mpsc::channel(1);
        let (camera, camera_rx) = flume::bounded(1);
        let (video_tx, output) = mpsc::channel(1);
        let (health_tx, _health_rx) = tokio::sync::mpsc::channel(4);
        let (done_tx, done) = tokio::sync::oneshot::channel();
        let stop = CancellationToken::new();
        let thread_stop = stop.clone();
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let _runtime = runtime.enter();
            let info = VideoInfo::from_raw_ffmpeg(Pixel::RGBA, 4, 4, 30);
            let result = compositor_thread(
                screen_rx,
                CameraReceiver::Raw(camera_rx),
                video_tx,
                thread_stop,
                health_tx,
                Compositor::new(info, presentation(2, 2)),
                first_camera,
            );
            let _ = done_tx.send(result);
        });
        TestCompositor {
            screen,
            camera,
            output,
            done,
            stop,
        }
    }

    #[tokio::test]
    async fn required_camera_disconnect_fails_without_screen_fallback() {
        ffmpeg::init().unwrap();
        let mut worker = start_test_compositor(camera_frame());
        drop(worker.camera);
        let _ = worker.screen.send(camera_frame()).await;
        assert!(
            tokio::time::timeout(Duration::from_secs(2), worker.done)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(worker.output.next().await.is_none());
    }

    #[tokio::test]
    async fn stale_camera_fails_even_without_screen_frames() {
        ffmpeg::init().unwrap();
        let mut frame = camera_frame();
        frame.timestamp =
            Timestamp::Instant(Instant::now().checked_sub(Duration::from_secs(2)).unwrap());
        let mut worker = start_test_compositor(frame);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), worker.done)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(worker.output.next().await.is_none());
    }

    #[tokio::test]
    async fn invalid_screen_composition_fails_without_output() {
        ffmpeg::init().unwrap();
        let mut worker = start_test_compositor(camera_frame());
        worker
            .screen
            .send(FFmpegVideoFrame {
                inner: ffmpeg::frame::Video::empty(),
                timestamp: Timestamp::Instant(Instant::now()),
            })
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), worker.done)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(worker.output.next().await.is_none());
    }

    #[tokio::test]
    async fn invalid_camera_update_fails_without_output() {
        ffmpeg::init().unwrap();
        let mut worker = start_test_compositor(camera_frame());
        assert!(
            worker
                .camera
                .send(FFmpegVideoFrame {
                    inner: ffmpeg::frame::Video::empty(),
                    timestamp: Timestamp::Instant(Instant::now())
                })
                .is_ok()
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(2), worker.done)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(worker.output.next().await.is_none());
    }

    #[tokio::test]
    async fn dropping_source_guard_cancels_compositor_without_screen_frames() {
        ffmpeg::init().unwrap();
        let mut worker = start_test_compositor(camera_frame());
        let source_guard = worker.stop.clone().drop_guard();
        drop(source_guard);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), worker.done)
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        assert!(worker.output.next().await.is_none());
    }

    #[tokio::test]
    async fn first_output_contains_camera_and_stop_closes_compositor() {
        ffmpeg::init().unwrap();
        let mut worker = start_test_compositor(camera_frame());
        let mut screen = camera_frame();
        screen.inner.data_mut(0).fill(0);
        screen.inner.set_pts(Some(71));
        worker.screen.send(screen).await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(2), worker.output.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&output.inner.data(0)[..4], &[200, 10, 20, 255]);
        assert_eq!(output.inner.pts(), Some(71));
        worker.stop.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), worker.done)
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        assert!(worker.output.next().await.is_none());
    }

    #[test]
    fn camera_freshness_expires_after_one_second() {
        let now = Instant::now();
        assert!(!camera_is_fresh(
            now,
            now + CAMERA_STALE_AFTER + Duration::from_millis(1)
        ));
        assert!(camera_is_fresh(now, now + CAMERA_STALE_AFTER));
    }

    #[test]
    fn camera_freshness_uses_capture_time_for_queued_frames() {
        ffmpeg::init().expect("FFmpeg initializes");
        let now = Instant::now();
        let captured_at = now
            .checked_sub(CAMERA_STALE_AFTER + Duration::from_millis(1))
            .expect("test instant has enough history");
        let frame = FFmpegVideoFrame {
            inner: ffmpeg::frame::Video::new(Pixel::RGBA, 1, 1),
            timestamp: Timestamp::Instant(captured_at),
        };
        assert!(!camera_is_fresh(camera_freshness_anchor(&frame, now), now));
        assert_eq!(camera_freshness_anchor(&frame, now), captured_at);
    }

    #[test]
    fn overlay_rect_is_bottom_right_and_safe_for_tiny_frames() {
        assert_eq!(overlay_rect(100, 50), (84, 34, 15));
        assert_eq!(overlay_rect(1, 1), (0, 0, 1));
        assert_eq!(overlay_rect(0, 50), (0, 0, 0));
        assert_eq!(overlay_rect(100, 0), (0, 0, 0));
    }

    #[test]
    fn center_crop_square_preserves_center_pixel() {
        ffmpeg::init().expect("FFmpeg initializes");
        let mut source = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 6, 4);
        source.data_mut(0).fill(0);
        let stride = source.stride(0);
        let center = 2 * stride + 2 * 4;
        source.data_mut(0)[center..center + 4].copy_from_slice(&[1, 2, 3, 255]);
        let cropped = crop_camera(
            &source,
            LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2,
                },
                ..LinuxCameraPresentation::default_for(2, 2)
            },
        )
        .expect("crop succeeds");
        assert_eq!(
            &cropped.data(0)[cropped.stride(0)..cropped.stride(0) + 4],
            &[1, 2, 3, 255]
        );
    }

    #[test]
    fn compositor_converts_nv12_camera_without_mutating_screen_and_preserves_pts() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::BGRA, 8, 8, 30);
        let mut screen = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 8, 8);
        for pixel in screen.data_mut(0).chunks_exact_mut(4) {
            pixel.copy_from_slice(&[0, 255, 0, 255]);
        }
        screen.set_pts(Some(1234));
        let original = screen.data(0).to_vec();
        let mut camera = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 4, 4);
        camera.data_mut(0).fill(235);
        camera.data_mut(1).fill(128);
        let camera_before = (camera.data(0).to_vec(), camera.data(1).to_vec());
        let screen_frame = FFmpegVideoFrame {
            inner: screen,
            timestamp,
        };
        let camera_frame = FFmpegVideoFrame {
            inner: camera,
            timestamp,
        };
        let mut compositor = Compositor::new(
            info,
            LinuxCameraPresentation::default_for(info.width, info.height),
        );
        let output = compositor
            .compose(&screen_frame, &camera_frame)
            .expect("composition succeeds");
        assert_eq!(screen_frame.inner.data(0), original.as_slice());
        assert_eq!(camera_frame.inner.data(0), camera_before.0.as_slice());
        assert_eq!(camera_frame.inner.data(1), camera_before.1.as_slice());
        assert_eq!(output.inner.pts(), Some(1234));
        assert!(matches!(
            (output.timestamp, timestamp),
            (Timestamp::Instant(actual), Timestamp::Instant(expected)) if actual == expected
        ));
        assert_ne!(
            &output.inner.data(0)[output.inner.stride(0) * 7 + 7 * 4..][..3],
            &[0, 255, 0]
        );
    }

    #[test]
    fn compositor_converts_nv12_screen_and_preserves_input() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(Pixel::NV12, 8, 8, 30);
        let mut screen = ffmpeg::frame::Video::new(Pixel::NV12, 8, 8);
        screen.data_mut(0).fill(16);
        screen.data_mut(1).fill(128);
        screen.set_pts(Some(4321));
        let original_y = screen.data(0).to_vec();
        let mut camera = ffmpeg::frame::Video::new(Pixel::BGRA, 4, 4);
        for pixel in camera.data_mut(0).chunks_exact_mut(4) {
            pixel.copy_from_slice(&[0, 0, 255, 255]);
        }
        let screen_frame = FFmpegVideoFrame {
            inner: screen,
            timestamp,
        };
        let camera_frame = FFmpegVideoFrame {
            inner: camera,
            timestamp,
        };
        let mut compositor = Compositor::new(
            info,
            LinuxCameraPresentation::default_for(info.width, info.height),
        );
        let output = compositor
            .compose(&screen_frame, &camera_frame)
            .expect("composition succeeds");
        assert_eq!(screen_frame.inner.data(0), original_y.as_slice());
        assert_eq!(output.inner.format(), Pixel::NV12);
        assert_eq!(output.inner.pts(), Some(4321));
        assert_ne!(output.inner.data(0)[output.inner.stride(0) * 7 + 7], 16);
    }

    #[test]
    fn blend_rejects_overlay_outside_screen_bounds() {
        ffmpeg::init().expect("FFmpeg initializes");
        let mut destination = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 2, 2);
        let source = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 2, 2);
        assert!(blend_rgba(&mut destination, &source, 1, 0).is_err());
    }
}
