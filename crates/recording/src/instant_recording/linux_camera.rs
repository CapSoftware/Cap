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

#[derive(Clone)]
pub struct LinuxCameraPixels(Arc<dyn AsRef<[u8]> + Send + Sync>);

impl LinuxCameraPixels {
    pub fn new(pixels: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        Self(Arc::new(pixels))
    }
}

impl std::ops::Deref for LinuxCameraPixels {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        (*self.0).as_ref()
    }
}

impl std::fmt::Debug for LinuxCameraPixels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinuxCameraPixels")
            .field("len", &self.len())
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct LinuxProcessedCameraFrame {
    pub bgra: LinuxCameraPixels,
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
    Compositor::new(info, presentation).camera_overlay(&first.inner, 0)?;
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
        let mut camera_generation = 0u64;
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
                    camera_generation += 1;
                    validate_camera_frame(&latest_camera, Instant::now())?;
                    freshness_anchor = camera_freshness_anchor(&latest_camera, Instant::now());
                }
                Event::Screen(Some(screen)) => {
                    if let Some(frame) = camera_rx.latest()? {
                        latest_camera = frame;
                        camera_generation += 1;
                        freshness_anchor = camera_freshness_anchor(&latest_camera, Instant::now());
                    }
                    validate_camera_frame(&latest_camera, Instant::now())?;
                    let output = compositor
                        .compose(screen, &latest_camera, camera_generation)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlaySpanKind {
    Opaque,
    Transparent,
    Edge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OverlaySpan {
    start: u32,
    len: u32,
    kind: OverlaySpanKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct OverlayRuns {
    width: usize,
    height: usize,
    spans: Vec<OverlaySpan>,
    row_starts: Vec<u32>,
}

impl OverlayRuns {
    fn row(&self, index: usize) -> &[OverlaySpan] {
        let start = self.row_starts[index] as usize;
        let end = self.row_starts[index + 1] as usize;
        &self.spans[start..end]
    }
}

#[derive(Debug, Clone, PartialEq)]
struct OverlayRunKey {
    generation: u64,
    width: u32,
    height: u32,
    radius_bits: u64,
    mask: Arc<[f64]>,
    from_mask: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
struct OverlayRunCache {
    key: Option<OverlayRunKey>,
    runs: OverlayRuns,
    builds: u64,
}

fn stored_mask_matches(key: &OverlayRunKey, mask: &Arc<[f64]>) -> bool {
    Arc::ptr_eq(&key.mask, mask) || key.mask.as_ref() == mask.as_ref()
}

impl OverlayRunCache {
    fn matches_current(
        &self,
        generation: u64,
        radius_bits: u64,
        mask: &Arc<[f64]>,
        width: u32,
        height: u32,
    ) -> bool {
        let Some(key) = &self.key else {
            return false;
        };
        key.width == width
            && key.height == height
            && stored_mask_matches(key, mask)
            && if key.from_mask {
                key.radius_bits == radius_bits
            } else {
                key.generation == generation
            }
    }

    fn matches_mask(&self, radius_bits: u64, mask: &Arc<[f64]>, width: u32, height: u32) -> bool {
        let Some(key) = &self.key else {
            return false;
        };
        key.from_mask
            && key.radius_bits == radius_bits
            && key.width == width
            && key.height == height
            && stored_mask_matches(key, mask)
    }

    fn matches_frame(&self, generation: u64, mask: &Arc<[f64]>, width: u32, height: u32) -> bool {
        let Some(key) = &self.key else {
            return false;
        };
        !key.from_mask
            && key.generation == generation
            && key.width == width
            && key.height == height
            && stored_mask_matches(key, mask)
    }

    fn prepared_mask_runs(
        &self,
        radius_bits: u64,
        mask: &Arc<[f64]>,
        width: u32,
        height: u32,
    ) -> Option<&OverlayRuns> {
        self.matches_mask(radius_bits, mask, width, height)
            .then_some(&self.runs)
    }

    fn install(&mut self, key: OverlayRunKey, runs: OverlayRuns) {
        self.builds += 1;
        self.key = Some(key);
        self.runs = runs;
    }

    fn resolve(
        &mut self,
        generation: u64,
        mask: &Arc<[f64]>,
        frame: &ffmpeg::frame::Video,
    ) -> &OverlayRuns {
        let width = frame.width();
        let height = frame.height();
        if self.matches_frame(generation, mask, width, height) {
            return &self.runs;
        }
        let runs = overlay_runs(frame);
        self.install(
            OverlayRunKey {
                generation,
                width,
                height,
                radius_bits: 0,
                mask: Arc::clone(mask),
                from_mask: false,
            },
            runs,
        );
        &self.runs
    }
}

fn span_kind(alpha: u8) -> OverlaySpanKind {
    match alpha {
        0 => OverlaySpanKind::Transparent,
        255 => OverlaySpanKind::Opaque,
        _ => OverlaySpanKind::Edge,
    }
}

fn push_alpha_runs(spans: &mut Vec<OverlaySpan>, alphas: impl Iterator<Item = u8>) {
    let mut alphas = alphas.peekable();
    let mut index = 0u32;
    while let Some(alpha) = alphas.next() {
        let kind = span_kind(alpha);
        let start = index;
        index += 1;
        while alphas.peek().is_some_and(|next| span_kind(*next) == kind) {
            let _ = alphas.next();
            index += 1;
        }
        spans.push(OverlaySpan {
            start,
            len: index - start,
            kind,
        });
    }
}

#[cfg(test)]
fn classify_alpha_row(alphas: &[u8]) -> Vec<OverlaySpan> {
    let mut spans = Vec::new();
    push_alpha_runs(&mut spans, alphas.iter().copied());
    spans
}

fn overlay_runs(frame: &ffmpeg::frame::Video) -> OverlayRuns {
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let stride = frame.stride(0);
    let data = frame.data(0);
    let mut spans = Vec::new();
    let mut row_starts = Vec::with_capacity(height + 1);
    for row in 0..height {
        row_starts.push(spans.len() as u32);
        let row_bytes = &data[row * stride..][..width * 4];
        push_alpha_runs(&mut spans, row_bytes.chunks_exact(4).map(|p| p[3]));
    }
    row_starts.push(spans.len() as u32);
    OverlayRuns {
        width,
        height,
        spans,
        row_starts,
    }
}

struct Compositor {
    info: VideoInfo,
    presentation: LinuxCameraPresentation,
    screen_to_rgba: Option<RgbaConverter>,
    camera_to_rgba: Option<RgbaConverter>,
    rgba_to_screen: Option<RgbaConverter>,
    camera_overlay: Option<(u64, ffmpeg::frame::Video)>,
    camera_mask: Option<Arc<[f64]>>,
    run_cache: OverlayRunCache,
}

impl Compositor {
    fn new(info: VideoInfo, presentation: LinuxCameraPresentation) -> Self {
        Self {
            info,
            presentation,
            screen_to_rgba: None,
            camera_to_rgba: None,
            rgba_to_screen: None,
            camera_overlay: None,
            camera_mask: None,
            run_cache: OverlayRunCache::default(),
        }
    }

    fn overlay_is_current(&self, generation: u64, width: u32, height: u32) -> bool {
        let frame_ok = self.camera_overlay.as_ref().is_some_and(|(cached, frame)| {
            *cached == generation && frame.width() == width && frame.height() == height
        });
        if !frame_ok {
            return false;
        }
        let Some(mask) = self.camera_mask.as_ref() else {
            return false;
        };
        self.run_cache.matches_current(
            generation,
            self.presentation.radius().to_bits(),
            mask,
            width,
            height,
        )
    }

    fn ensure_camera_overlay(
        &mut self,
        input: &ffmpeg::frame::Video,
        generation: u64,
    ) -> anyhow::Result<()> {
        let presentation = self.presentation;
        let width = presentation.rect.width;
        let height = presentation.rect.height;
        if self.camera_mask.is_none() {
            self.camera_mask = Some(Arc::from(camera_mask(presentation)));
        }
        if self.overlay_is_current(generation, width, height) {
            return Ok(());
        }
        let rgba = self.convert_camera(input, width, height)?;
        let mask = Arc::clone(self.camera_mask.as_ref().expect("camera mask"));
        let radius_bits = presentation.radius().to_bits();
        let (frame, applied) = {
            let prepared = self
                .run_cache
                .prepared_mask_runs(radius_bits, &mask, width, height);
            crop_camera_with_runs(&rgba, presentation, mask.as_ref(), prepared)?
        };
        if !applied {
            self.run_cache.resolve(generation, &mask, &frame);
        } else if !self
            .run_cache
            .matches_mask(radius_bits, &mask, width, height)
        {
            let runs = mask_overlay_runs(mask.as_ref(), width as usize, height as usize);
            self.run_cache.install(
                OverlayRunKey {
                    generation: 0,
                    width,
                    height,
                    radius_bits,
                    mask: Arc::clone(&mask),
                    from_mask: true,
                },
                runs,
            );
        }
        self.camera_overlay = Some((generation, frame));
        Ok(())
    }

    fn compose(
        &mut self,
        mut screen: FFmpegVideoFrame,
        camera: &FFmpegVideoFrame,
        camera_generation: u64,
    ) -> anyhow::Result<FFmpegVideoFrame> {
        let Some(layout) = self.in_place_layout(&mut screen.inner) else {
            return self.compose_converted(&screen, camera, camera_generation);
        };
        self.presentation
            .validate(self.info.width, self.info.height)?;
        let rect = self.presentation.rect;
        self.ensure_camera_overlay(&camera.inner, camera_generation)?;
        let camera_overlay = &self
            .camera_overlay
            .as_ref()
            .expect("camera overlay prepared")
            .1;
        let runs = &self.run_cache.runs;
        blend_rgba_into_packed_with_runs(
            &mut screen.inner,
            layout,
            camera_overlay,
            rect.x as usize,
            rect.y as usize,
            Some(runs),
        )?;
        Ok(screen)
    }

    fn in_place_layout(&self, screen: &mut ffmpeg::frame::Video) -> Option<PackedRgbLayout> {
        if screen.format() != self.info.pixel_format
            || screen.width() != self.info.width
            || screen.height() != self.info.height
        {
            return None;
        }
        let layout = PackedRgbLayout::of(screen.format())?;
        let writable = unsafe { ffmpeg::sys::av_frame_make_writable(screen.as_mut_ptr()) };
        (writable >= 0).then_some(layout)
    }

    fn compose_converted(
        &mut self,
        screen: &FFmpegVideoFrame,
        camera: &FFmpegVideoFrame,
        camera_generation: u64,
    ) -> anyhow::Result<FFmpegVideoFrame> {
        let mut composed = self.convert_screen(&screen.inner)?;
        self.presentation
            .validate(self.info.width, self.info.height)?;
        let rect = self.presentation.rect;
        self.ensure_camera_overlay(&camera.inner, camera_generation)?;
        let camera_overlay = &self
            .camera_overlay
            .as_ref()
            .expect("camera overlay prepared")
            .1;
        let runs = &self.run_cache.runs;
        blend_rgba_with_runs(
            &mut composed,
            camera_overlay,
            rect.x as usize,
            rect.y as usize,
            Some(runs),
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
        camera_generation: u64,
    ) -> anyhow::Result<&ffmpeg::frame::Video> {
        self.ensure_camera_overlay(input, camera_generation)?;
        Ok(&self
            .camera_overlay
            .as_ref()
            .expect("camera overlay prepared")
            .1)
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

fn camera_mask(presentation: LinuxCameraPresentation) -> Vec<f64> {
    let rect = presentation.rect;
    let radius = presentation.radius();
    if radius <= 0.0 {
        return Vec::new();
    }
    let mut mask = Vec::with_capacity(rect.width as usize * rect.height as usize);
    for y in 0..rect.height as usize {
        for x in 0..rect.width as usize {
            let px = x as f64 + 0.5;
            let py = y as f64 + 0.5;
            let dx = px - px.clamp(radius, f64::from(rect.width) - radius);
            let dy = py - py.clamp(radius, f64::from(rect.height) - radius);
            mask.push((radius + 0.5 - dx.hypot(dy)).clamp(0.0, 1.0));
        }
    }
    mask
}

fn mask_alpha(mask: &[f64], index: usize) -> u8 {
    match mask.get(index) {
        Some(coverage) => (f64::from(255u8) * coverage).round() as u8,
        None => 255,
    }
}

fn mask_overlay_runs(mask: &[f64], width: usize, height: usize) -> OverlayRuns {
    let mut spans = Vec::new();
    let mut row_starts = Vec::with_capacity(height + 1);
    for y in 0..height {
        row_starts.push(spans.len() as u32);
        let row = y * width;
        push_alpha_runs(&mut spans, (0..width).map(|x| mask_alpha(mask, row + x)));
    }
    row_starts.push(spans.len() as u32);
    OverlayRuns {
        width,
        height,
        spans,
        row_starts,
    }
}

#[cfg(test)]
fn crop_camera(
    source: &ffmpeg::frame::Video,
    presentation: LinuxCameraPresentation,
    mask: &[f64],
) -> anyhow::Result<ffmpeg::frame::Video> {
    crop_camera_with_runs(source, presentation, mask, None).map(|(frame, _applied)| frame)
}

fn crop_camera_with_runs(
    source: &ffmpeg::frame::Video,
    presentation: LinuxCameraPresentation,
    mask: &[f64],
    runs: Option<&OverlayRuns>,
) -> anyhow::Result<(ffmpeg::frame::Video, bool)> {
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
    let width = rect.width as usize;
    let height = rect.height as usize;
    let mut output = ffmpeg::frame::Video::new(Pixel::RGBA, rect.width, rect.height);
    let source_stride = source.stride(0);
    let output_stride = output.stride(0);
    let source_data = source.data(0);
    let output_data = output.data_mut(0);
    let opaque = rgba_window_is_opaque(source_data, source_stride, crop_x, crop_y, width, height);
    let rows_fit = rgba_rows_fit(output_data.len(), output_stride, 0, width * 4, 0, height);
    if opaque && rows_fit && mask.is_empty() {
        copy_cropped_rgba_rows(
            output_data,
            source_data,
            PlaneWindow {
                source_stride,
                destination_stride: output_stride,
                source_x: crop_x,
                source_y: crop_y,
                destination_x: 0,
                destination_y: 0,
                width,
                height,
            },
            presentation.mirrored,
        );
        output.set_pts(source.pts());
        return Ok((output, false));
    }
    if opaque && rows_fit && !mask.is_empty() {
        let owned_runs;
        let runs = match runs {
            Some(runs) if runs.width == width && runs.height == height => runs,
            _ => {
                owned_runs = mask_overlay_runs(mask, width, height);
                &owned_runs
            }
        };
        copy_masked_rgba_rows(
            output_data,
            source_data,
            PlaneWindow {
                source_stride,
                destination_stride: output_stride,
                source_x: crop_x,
                source_y: crop_y,
                destination_x: 0,
                destination_y: 0,
                width,
                height,
            },
            mask,
            runs,
            presentation.mirrored,
        );
        output.set_pts(source.pts());
        return Ok((output, true));
    }
    for y in 0..height {
        for x in 0..width {
            let source_x = crop_x
                + if presentation.mirrored {
                    width - 1 - x
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
            if let Some(&coverage) = mask.get(y * width + x) {
                destination[3] = (f64::from(destination[3]) * coverage).round() as u8;
            }
        }
    }
    output.set_pts(source.pts());
    Ok((output, false))
}

#[cfg(test)]
fn rgba_plane_is_opaque(data: &[u8], stride: usize, width: usize, height: usize) -> bool {
    rgba_window_is_opaque(data, stride, 0, 0, width, height)
}

fn rgba_window_is_opaque(
    data: &[u8],
    stride: usize,
    origin_x: usize,
    origin_y: usize,
    width: usize,
    height: usize,
) -> bool {
    let row_bytes = width * 4;
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        return unsafe {
            rgba_window_is_opaque_avx2(data, stride, origin_x, origin_y, row_bytes, height)
        };
    }
    rgba_window_is_opaque_scalar(data, stride, origin_x, origin_y, row_bytes, height)
}

fn rgba_window_is_opaque_scalar(
    data: &[u8],
    stride: usize,
    origin_x: usize,
    origin_y: usize,
    row_bytes: usize,
    height: usize,
) -> bool {
    (0..height).all(|row| {
        let start = (origin_y + row) * stride + origin_x * 4;
        data.get(start..start + row_bytes)
            .is_some_and(rgba_bytes_are_opaque)
    })
}

fn rgba_bytes_are_opaque(pixels: &[u8]) -> bool {
    const ALPHA_PAIR: u64 = 0xFF00_0000_FF00_0000;
    let (pairs, rest) = pixels.as_chunks::<8>();
    if pairs.iter().any(|pair| {
        let word = u64::from_le_bytes(*pair);
        (word & ALPHA_PAIR) != ALPHA_PAIR
    }) {
        return false;
    }
    rest.chunks_exact(4).all(|pixel| pixel[3] == 255)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn rgba_window_is_opaque_avx2(
    data: &[u8],
    stride: usize,
    origin_x: usize,
    origin_y: usize,
    row_bytes: usize,
    height: usize,
) -> bool {
    for row in 0..height {
        let start = (origin_y + row) * stride + origin_x * 4;
        let Some(pixels) = data.get(start..start + row_bytes) else {
            return false;
        };
        if unsafe { !rgba_bytes_are_opaque_avx2(pixels) } {
            return false;
        }
    }
    true
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn rgba_bytes_are_opaque_avx2(pixels: &[u8]) -> bool {
    use std::arch::x86_64::*;

    let alpha = _mm256_set1_epi32(i32::from_le_bytes([0x00, 0x00, 0x00, 0xFF]));
    let mut offset = 0;
    while offset + 32 <= pixels.len() {
        unsafe {
            let loaded = _mm256_loadu_si256(pixels.as_ptr().add(offset).cast());
            let masked = _mm256_and_si256(loaded, alpha);
            let same = _mm256_cmpeq_epi32(masked, alpha);
            if _mm256_movemask_epi8(same) != -1 {
                return false;
            }
        }
        offset += 32;
    }
    rgba_bytes_are_opaque(&pixels[offset..])
}

fn rgba_rows_fit(
    len: usize,
    stride: usize,
    origin_bytes: usize,
    row_bytes: usize,
    origin_y: usize,
    height: usize,
) -> bool {
    (0..height).all(|row| {
        let start = (origin_y + row) * stride + origin_bytes;
        start.checked_add(row_bytes).is_some_and(|end| end <= len)
    })
}

struct PlaneWindow {
    source_stride: usize,
    destination_stride: usize,
    source_x: usize,
    source_y: usize,
    destination_x: usize,
    destination_y: usize,
    width: usize,
    height: usize,
}

fn copy_cropped_rgba_rows(
    destination: &mut [u8],
    source: &[u8],
    window: PlaneWindow,
    mirrored: bool,
) {
    let row_bytes = window.width * 4;
    for row in 0..window.height {
        let src_start = (window.source_y + row) * window.source_stride + window.source_x * 4;
        let src = &source[src_start..src_start + row_bytes];
        let dst_start =
            (window.destination_y + row) * window.destination_stride + window.destination_x * 4;
        let dst = &mut destination[dst_start..dst_start + row_bytes];
        if mirrored {
            for (dst_pixel, src_pixel) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4).rev()) {
                dst_pixel.copy_from_slice(src_pixel);
            }
        } else {
            dst.copy_from_slice(src);
        }
    }
}

fn copy_masked_rgba_rows(
    destination: &mut [u8],
    source: &[u8],
    window: PlaneWindow,
    mask: &[f64],
    runs: &OverlayRuns,
    mirrored: bool,
) {
    for row in 0..window.height {
        for span in runs.row(row).iter().copied() {
            copy_masked_span(destination, source, &window, mask, row, span, mirrored);
        }
    }
}

fn copy_masked_span(
    destination: &mut [u8],
    source: &[u8],
    window: &PlaneWindow,
    mask: &[f64],
    row: usize,
    span: OverlaySpan,
    mirrored: bool,
) {
    let start = span.start as usize;
    let len = span.len as usize;
    let src_origin = if mirrored {
        window.source_x + window.width - (start + len)
    } else {
        window.source_x + start
    };
    let src_start = (window.source_y + row) * window.source_stride + src_origin * 4;
    let dst_start = (window.destination_y + row) * window.destination_stride
        + (window.destination_x + start) * 4;
    match span.kind {
        OverlaySpanKind::Opaque | OverlaySpanKind::Transparent => {
            let src = &source[src_start..src_start + len * 4];
            let dst = &mut destination[dst_start..dst_start + len * 4];
            if mirrored {
                for (dst_pixel, src_pixel) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4).rev())
                {
                    dst_pixel.copy_from_slice(src_pixel);
                    if span.kind == OverlaySpanKind::Transparent {
                        dst_pixel[3] = 0;
                    }
                }
            } else {
                dst.copy_from_slice(src);
                if span.kind == OverlaySpanKind::Transparent {
                    for pixel in dst.chunks_exact_mut(4) {
                        pixel[3] = 0;
                    }
                }
            }
        }
        OverlaySpanKind::Edge => {
            for offset in 0..len {
                let x = start + offset;
                let source_x = window.source_x + if mirrored { window.width - 1 - x } else { x };
                let src_offset = (window.source_y + row) * window.source_stride + source_x * 4;
                let dst_offset = (window.destination_y + row) * window.destination_stride
                    + (window.destination_x + x) * 4;
                let dst_pixel = &mut destination[dst_offset..dst_offset + 4];
                dst_pixel.copy_from_slice(&source[src_offset..src_offset + 4]);
                if let Some(&coverage) = mask.get(row * window.width + x) {
                    dst_pixel[3] = (f64::from(dst_pixel[3]) * coverage).round() as u8;
                }
            }
        }
    }
}

const RGBA_PACKED: PackedRgbLayout = PackedRgbLayout {
    bytes_per_pixel: 4,
    red: 0,
    green: 1,
    blue: 2,
    opaque: Some(3),
};

const BGRA_PACKED: PackedRgbLayout = PackedRgbLayout {
    bytes_per_pixel: 4,
    red: 2,
    green: 1,
    blue: 0,
    opaque: Some(3),
};

#[cfg(test)]
fn blend_rgba(
    destination: &mut ffmpeg::frame::Video,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
) -> anyhow::Result<()> {
    blend_rgba_with_runs(destination, source, x, y, None)
}

fn blend_rgba_with_runs(
    destination: &mut ffmpeg::frame::Video,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
    runs: Option<&OverlayRuns>,
) -> anyhow::Result<()> {
    if destination.format() != ffmpeg::format::Pixel::RGBA
        || source.format() != ffmpeg::format::Pixel::RGBA
    {
        return Err(anyhow!("RGBA blend requires RGBA frames"));
    }
    blend_overlay(destination, RGBA_PACKED, source, x, y, runs)
}

#[cfg(test)]
fn copy_rgba_rows(destination: &mut [u8], source: &[u8], window: PlaneWindow) {
    let row_bytes = window.width * 4;
    for row in 0..window.height {
        let src_start = (window.source_y + row) * window.source_stride + window.source_x * 4;
        let dst_start =
            (window.destination_y + row) * window.destination_stride + window.destination_x * 4;
        destination[dst_start..dst_start + row_bytes]
            .copy_from_slice(&source[src_start..src_start + row_bytes]);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PackedRgbLayout {
    bytes_per_pixel: usize,
    red: usize,
    green: usize,
    blue: usize,
    opaque: Option<usize>,
}

impl PackedRgbLayout {
    fn of(format: Pixel) -> Option<Self> {
        let four = |red, green, blue, opaque| Self {
            bytes_per_pixel: 4,
            red,
            green,
            blue,
            opaque: Some(opaque),
        };
        let three = |red, green, blue| Self {
            bytes_per_pixel: 3,
            red,
            green,
            blue,
            opaque: None,
        };
        match format {
            Pixel::RGBA | Pixel::RGBZ => Some(four(0, 1, 2, 3)),
            Pixel::BGRA | Pixel::BGRZ => Some(four(2, 1, 0, 3)),
            Pixel::ARGB | Pixel::ZRGB => Some(four(1, 2, 3, 0)),
            Pixel::ABGR | Pixel::ZBGR => Some(four(3, 2, 1, 0)),
            Pixel::RGB24 => Some(three(0, 1, 2)),
            Pixel::BGR24 => Some(three(2, 1, 0)),
            _ => None,
        }
    }
}

#[cfg(test)]
fn blend_rgba_into_packed(
    destination: &mut ffmpeg::frame::Video,
    layout: PackedRgbLayout,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
) -> anyhow::Result<()> {
    blend_rgba_into_packed_with_runs(destination, layout, source, x, y, None)
}

fn blend_rgba_into_packed_with_runs(
    destination: &mut ffmpeg::frame::Video,
    layout: PackedRgbLayout,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
    runs: Option<&OverlayRuns>,
) -> anyhow::Result<()> {
    if source.format() != Pixel::RGBA {
        return Err(anyhow!("camera overlay must be RGBA"));
    }
    blend_overlay(destination, layout, source, x, y, runs)
}

fn blend_overlay(
    destination: &mut ffmpeg::frame::Video,
    layout: PackedRgbLayout,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
    runs: Option<&OverlayRuns>,
) -> anyhow::Result<()> {
    let source_width = source.width() as usize;
    let source_height = source.height() as usize;
    if x.saturating_add(source_width) > destination.width() as usize
        || y.saturating_add(source_height) > destination.height() as usize
    {
        return Err(anyhow!("camera overlay exceeds screen frame"));
    }
    let source_stride = source.stride(0);
    let destination_stride = destination.stride(0);
    let owned_runs;
    let runs = match runs {
        Some(runs) if runs.width == source_width && runs.height == source_height => runs,
        _ => {
            owned_runs = overlay_runs(source);
            &owned_runs
        }
    };
    let source_data = source.data(0);
    let destination_data = destination.data_mut(0);
    let bytes_per_pixel = layout.bytes_per_pixel;
    for row in 0..source_height {
        let source_row = &source_data[row * source_stride..][..source_width * 4];
        let destination_row = &mut destination_data
            [(y + row) * destination_stride + x * bytes_per_pixel..]
            [..source_width * bytes_per_pixel];
        for span in runs.row(row) {
            apply_overlay_span(source_row, destination_row, *span, layout);
        }
    }
    Ok(())
}

fn apply_overlay_span(
    source_row: &[u8],
    destination_row: &mut [u8],
    span: OverlaySpan,
    layout: PackedRgbLayout,
) {
    let start = span.start as usize;
    let len = span.len as usize;
    let source_span = &source_row[start * 4..][..len * 4];
    let destination_span =
        &mut destination_row[start * layout.bytes_per_pixel..][..len * layout.bytes_per_pixel];
    match span.kind {
        OverlaySpanKind::Opaque => copy_opaque_span(source_span, destination_span, layout),
        OverlaySpanKind::Transparent => {
            // Alpha 0 leaves color untouched. The blend formula still forces a packed opaque byte to 255.
            if let Some(opaque) = layout.opaque {
                for pixel in destination_span.chunks_exact_mut(layout.bytes_per_pixel) {
                    pixel[opaque] = 255;
                }
            }
        }
        OverlaySpanKind::Edge => {
            for (source_pixel, destination_pixel) in source_span
                .chunks_exact(4)
                .zip(destination_span.chunks_exact_mut(layout.bytes_per_pixel))
            {
                let alpha = u16::from(source_pixel[3]);
                let inverse_alpha = 255 - alpha;
                for (channel, offset) in [layout.red, layout.green, layout.blue]
                    .into_iter()
                    .enumerate()
                {
                    destination_pixel[offset] = ((u16::from(source_pixel[channel]) * alpha
                        + u16::from(destination_pixel[offset]) * inverse_alpha
                        + 127)
                        / 255) as u8;
                }
                if let Some(opaque) = layout.opaque {
                    destination_pixel[opaque] = 255;
                }
            }
        }
    }
}

fn copy_opaque_span(source: &[u8], destination: &mut [u8], layout: PackedRgbLayout) {
    if layout == RGBA_PACKED {
        destination.copy_from_slice(source);
        return;
    }
    if layout == BGRA_PACKED {
        copy_rgba_to_bgra(source, destination);
        return;
    }
    copy_opaque_rgba_pixels(source, destination, layout);
}

#[cfg(test)]
fn copy_opaque_rgba_into_packed(
    destination: &mut [u8],
    source: &[u8],
    window: PlaneWindow,
    layout: PackedRgbLayout,
) {
    if layout == RGBA_PACKED {
        copy_rgba_rows(destination, source, window);
        return;
    }
    if layout == BGRA_PACKED {
        copy_rgba_rows_to_bgra(destination, source, window);
        return;
    }
    let source_row_bytes = window.width * 4;
    let destination_row_bytes = window.width * layout.bytes_per_pixel;
    for row in 0..window.height {
        let src_start = (window.source_y + row) * window.source_stride + window.source_x * 4;
        let dst_start = (window.destination_y + row) * window.destination_stride
            + window.destination_x * layout.bytes_per_pixel;
        copy_opaque_rgba_pixels(
            &source[src_start..src_start + source_row_bytes],
            &mut destination[dst_start..dst_start + destination_row_bytes],
            layout,
        );
    }
}

fn copy_opaque_rgba_pixels(source: &[u8], destination: &mut [u8], layout: PackedRgbLayout) {
    for (source_pixel, destination_pixel) in source
        .chunks_exact(4)
        .zip(destination.chunks_exact_mut(layout.bytes_per_pixel))
    {
        destination_pixel[layout.red] = source_pixel[0];
        destination_pixel[layout.green] = source_pixel[1];
        destination_pixel[layout.blue] = source_pixel[2];
        if let Some(opaque) = layout.opaque {
            destination_pixel[opaque] = 255;
        }
    }
}

fn copy_rgba_to_bgra(source: &[u8], destination: &mut [u8]) {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            unsafe {
                copy_rgba_to_bgra_avx2_bytes(source, destination);
            }
            return;
        }
    }
    copy_rgba_to_bgra_scalar(source, destination);
}

#[cfg(test)]
fn copy_rgba_rows_to_bgra(destination: &mut [u8], source: &[u8], window: PlaneWindow) {
    let row_bytes = window.width * 4;
    for row in 0..window.height {
        let src_start = (window.source_y + row) * window.source_stride + window.source_x * 4;
        let dst_start =
            (window.destination_y + row) * window.destination_stride + window.destination_x * 4;
        copy_rgba_to_bgra(
            &source[src_start..src_start + row_bytes],
            &mut destination[dst_start..dst_start + row_bytes],
        );
    }
}

fn copy_rgba_to_bgra_scalar(source: &[u8], destination: &mut [u8]) {
    for (source_pixel, destination_pixel) in
        source.chunks_exact(4).zip(destination.chunks_exact_mut(4))
    {
        destination_pixel[0] = source_pixel[2];
        destination_pixel[1] = source_pixel[1];
        destination_pixel[2] = source_pixel[0];
        destination_pixel[3] = source_pixel[3];
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn copy_rgba_to_bgra_avx2_bytes(source: &[u8], destination: &mut [u8]) {
    use std::arch::x86_64::*;

    let row_bytes = source.len();
    let shuffle = _mm256_setr_epi8(
        2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15, 18, 17, 16, 19, 22, 21, 20, 23, 26,
        25, 24, 27, 30, 29, 28, 31,
    );
    let mut offset = 0;
    while offset + 32 <= row_bytes {
        unsafe {
            let loaded = _mm256_loadu_si256(source.as_ptr().add(offset).cast());
            let shuffled = _mm256_shuffle_epi8(loaded, shuffle);
            _mm256_storeu_si256(destination.as_mut_ptr().add(offset).cast(), shuffled);
        }
        offset += 32;
    }
    copy_rgba_to_bgra_scalar(&source[offset..], &mut destination[offset..]);
}

#[cfg(all(test, target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn copy_rgba_rows_to_bgra_avx2(destination: &mut [u8], source: &[u8], window: PlaneWindow) {
    let row_bytes = window.width * 4;
    for row in 0..window.height {
        let src_start = (window.source_y + row) * window.source_stride + window.source_x * 4;
        let dst_start =
            (window.destination_y + row) * window.destination_stride + window.destination_x * 4;
        unsafe {
            copy_rgba_to_bgra_avx2_bytes(
                &source[src_start..src_start + row_bytes],
                &mut destination[dst_start..dst_start + row_bytes],
            );
        }
    }
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
            bgra: LinuxCameraPixels::new([
                10, 20, 30, 255, 40, 50, 60, 255, 99, 99, 99, 99, 70, 80, 90, 255, 100, 110, 120,
                255, 99, 99, 99, 99u8,
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
        let overlay = compositor.camera_overlay(&converted.inner, 0).unwrap();
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
        invalid.bgra = LinuxCameraPixels::new([0u8; 23]);
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
        let output = crop_camera(&frame, request, &camera_mask(request)).unwrap();
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
            let request = LinuxCameraPresentation {
                shape,
                ..presentation(8, 8)
            };
            let output = crop_camera(&frame, request, &camera_mask(request)).unwrap();
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
        let request = LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
            },
            ..LinuxCameraPresentation::default_for(2, 2)
        };
        let cropped = crop_camera(&source, request, &camera_mask(request)).expect("crop succeeds");
        assert_eq!(
            &cropped.data(0)[cropped.stride(0)..cropped.stride(0) + 4],
            &[1, 2, 3, 255]
        );
    }

    #[test]
    fn compositor_converts_nv12_camera_without_mutating_shared_screen_and_preserves_pts() {
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
        let shared = shared_ref(&screen_frame.inner);
        let output = compositor
            .compose(screen_frame, &camera_frame, 0)
            .expect("composition succeeds");
        assert_eq!(shared.data(0), original.as_slice());
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

    fn plane_buffer_refcount(frame: &ffmpeg::frame::Video) -> i32 {
        let buffer = unsafe { (*frame.as_ptr()).buf[0] };
        assert!(!buffer.is_null());
        unsafe { ffmpeg::ffi::av_buffer_get_ref_count(buffer) }
    }

    #[test]
    fn shared_camera_pixels_survive_one_opaque_composite() {
        ffmpeg::init().expect("FFmpeg initializes");
        let now = Instant::now();
        let size = 16u32;
        let row = size as usize * 4;
        let mut bytes = vec![0u8; row * size as usize];
        for pixel in bytes.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[11, 22, 33, 255]);
        }
        let bgra = LinuxCameraPixels::new(bytes);
        let shared_pixels = bgra.clone();
        let source = shared_pixels.as_ptr();
        let processed = LinuxProcessedCameraFrame {
            bgra,
            dimensions: (size, size),
            stride: row,
            timestamp: Timestamp::Instant(now),
            generation: 3,
            processing: LinuxCameraProcessing {
                mirrored: false,
                blur: LinuxCameraBlur::Off,
            },
            mask: None,
        };
        let converted = processed_to_ffmpeg(&processed).expect("processed frame");
        assert_eq!(processed.bgra.as_ptr(), source);
        assert_eq!(shared_pixels.as_ptr(), source);
        assert_ne!(converted.inner.data(0).as_ptr(), source);
        let camera_pixels = converted.inner.data(0).as_ptr();
        let shared_frame = shared_ref(&converted.inner);
        assert_eq!(plane_buffer_refcount(&converted.inner), 2);
        assert_eq!(shared_frame.data(0).as_ptr(), camera_pixels);

        let timestamp = converted.timestamp;
        let camera_frame = FFmpegVideoFrame {
            inner: converted.inner,
            timestamp,
        };
        let screen_size = 20u32;
        let origin_x = 2usize;
        let origin_y = 1usize;
        let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRA, screen_size, screen_size, 30);
        let presentation = LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: origin_x as u32,
                y: origin_y as u32,
                width: size,
                height: size,
            },
            shape: LinuxCameraShape::Round,
            mirrored: false,
            effect: LinuxCameraEffect::None,
        };
        let mut template = ffmpeg::frame::Video::new(Pixel::BGRA, screen_size, screen_size);
        template.data_mut(0).fill(9);
        template.set_pts(Some(42));
        let mut compositor = Compositor::new(info, presentation);
        let layout = PackedRgbLayout::of(Pixel::BGRA).expect("bgra layout");
        let first = compositor
            .compose(
                FFmpegVideoFrame {
                    inner: copy_frame(&template),
                    timestamp,
                },
                &camera_frame,
                4,
            )
            .expect("first composite");
        assert_eq!(compositor.run_cache.builds, 1);
        assert!(
            compositor
                .run_cache
                .runs
                .spans
                .iter()
                .any(|span| span.kind == OverlaySpanKind::Opaque)
        );
        let overlay_pixels = compositor
            .camera_overlay
            .as_ref()
            .expect("overlay")
            .1
            .data(0)
            .as_ptr();
        let mut expected = copy_frame(&template);
        formula_blend_packed(
            &mut expected,
            layout,
            &compositor.camera_overlay.as_ref().expect("overlay").1,
            origin_x,
            origin_y,
        );
        assert_planes_equal(&first.inner, &expected);

        let second = compositor
            .compose(
                FFmpegVideoFrame {
                    inner: copy_frame(&template),
                    timestamp,
                },
                &camera_frame,
                4,
            )
            .expect("second composite");
        assert_eq!(compositor.run_cache.builds, 1);
        assert_eq!(
            compositor
                .camera_overlay
                .as_ref()
                .expect("overlay")
                .1
                .data(0)
                .as_ptr(),
            overlay_pixels
        );
        assert_planes_equal(&second.inner, &expected);
        assert_eq!(camera_frame.inner.data(0).as_ptr(), camera_pixels);
        assert_eq!(shared_frame.data(0).as_ptr(), camera_pixels);
        assert_eq!(plane_buffer_refcount(&camera_frame.inner), 2);
        assert_eq!(processed.bgra.as_ptr(), source);
        assert_eq!(shared_pixels.as_ptr(), source);
        assert_eq!(&shared_pixels[..4], &[11, 22, 33, 255]);
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
        let shared = shared_ref(&screen_frame.inner);
        let output = compositor
            .compose(screen_frame, &camera_frame, 0)
            .expect("composition succeeds");
        assert_eq!(shared.data(0), original_y.as_slice());
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

    fn shared_ref(frame: &ffmpeg::frame::Video) -> ffmpeg::frame::Video {
        let mut shared = ffmpeg::frame::Video::empty();
        let result = unsafe { ffmpeg::sys::av_frame_ref(shared.as_mut_ptr(), frame.as_ptr()) };
        assert!(result >= 0);
        shared
    }

    fn pattern_frame(format: Pixel, width: u32, height: u32, seed: u32) -> ffmpeg::frame::Video {
        let mut frame = ffmpeg::frame::Video::new(format, width, height);
        let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        for plane in 0..frame.planes() {
            for byte in frame.data_mut(plane) {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *byte = (state >> 24) as u8;
            }
        }
        frame
    }

    fn copy_frame(frame: &ffmpeg::frame::Video) -> ffmpeg::frame::Video {
        let mut copy = ffmpeg::frame::Video::new(frame.format(), frame.width(), frame.height());
        for plane in 0..frame.planes() {
            copy.data_mut(plane).copy_from_slice(frame.data(plane));
        }
        copy.set_pts(frame.pts());
        copy
    }

    fn defined_bytes(frame: &ffmpeg::frame::Video) -> Vec<u8> {
        let layout = PackedRgbLayout::of(frame.format()).unwrap();
        let padding = match frame.format() {
            Pixel::RGBZ | Pixel::BGRZ | Pixel::ZRGB | Pixel::ZBGR => layout.opaque,
            _ => None,
        };
        let row_bytes = frame.width() as usize * layout.bytes_per_pixel;
        frame
            .data(0)
            .chunks(frame.stride(0))
            .take(frame.height() as usize)
            .flat_map(|row| row[..row_bytes].chunks_exact(layout.bytes_per_pixel))
            .flat_map(|pixel| {
                pixel
                    .iter()
                    .enumerate()
                    .map(move |(offset, &byte)| if Some(offset) == padding { 0 } else { byte })
            })
            .collect()
    }

    #[test]
    fn in_place_composition_matches_converted_composition_for_packed_formats() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let (width, height) = (37, 23);
        for format in [
            Pixel::BGRZ,
            Pixel::RGBZ,
            Pixel::ZRGB,
            Pixel::ZBGR,
            Pixel::BGRA,
            Pixel::RGBA,
            Pixel::ARGB,
            Pixel::ABGR,
            Pixel::RGB24,
            Pixel::BGR24,
        ] {
            for (shape, mirrored) in [
                (LinuxCameraShape::Round, false),
                (LinuxCameraShape::Round, true),
                (
                    LinuxCameraShape::RoundedRectangle { radius_pixels: 3 },
                    false,
                ),
            ] {
                let info = VideoInfo::from_raw_ffmpeg(format, width, height, 30);
                let presentation = LinuxCameraPresentation {
                    rect: LinuxCameraRect {
                        x: 19,
                        y: 6,
                        width: 15,
                        height: 15,
                    },
                    shape,
                    mirrored,
                    effect: LinuxCameraEffect::None,
                };
                let mut screen = pattern_frame(format, width, height, 7);
                screen.set_pts(Some(99));
                let camera = FFmpegVideoFrame {
                    inner: pattern_frame(Pixel::YUV420P, 32, 18, 11),
                    timestamp,
                };
                let expected = Compositor::new(info, presentation)
                    .compose_converted(
                        &FFmpegVideoFrame {
                            inner: copy_frame(&screen),
                            timestamp,
                        },
                        &camera,
                        0,
                    )
                    .expect("converted composition succeeds");
                let mut compositor = Compositor::new(info, presentation);
                let mut probe = copy_frame(&screen);
                assert!(compositor.in_place_layout(&mut probe).is_some());
                let actual = compositor
                    .compose(
                        FFmpegVideoFrame {
                            inner: screen,
                            timestamp,
                        },
                        &camera,
                        0,
                    )
                    .expect("in-place composition succeeds");
                assert_eq!(
                    defined_bytes(&actual.inner),
                    defined_bytes(&expected.inner),
                    "{format:?} {shape:?} mirrored={mirrored}"
                );
                assert_eq!(actual.inner.pts(), Some(99));
            }
        }
    }

    #[test]
    fn camera_overlay_is_reused_until_a_new_camera_frame_arrives() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 16, 16, 30);
        let mut compositor = Compositor::new(info, LinuxCameraPresentation::default_for(16, 16));
        let camera = |seed| FFmpegVideoFrame {
            inner: pattern_frame(Pixel::RGBA, 8, 8, seed),
            timestamp,
        };
        let screen = || FFmpegVideoFrame {
            inner: pattern_frame(Pixel::BGRZ, 16, 16, 3),
            timestamp,
        };
        let first = compositor.compose(screen(), &camera(1), 1).unwrap();
        assert_eq!(compositor.run_cache.builds, 1);
        let reused = compositor.compose(screen(), &camera(2), 1).unwrap();
        assert_eq!(compositor.run_cache.builds, 1);
        let refreshed = compositor.compose(screen(), &camera(2), 2).unwrap();
        assert_eq!(compositor.run_cache.builds, 2);
        assert_eq!(first.inner.data(0), reused.inner.data(0));
        assert_ne!(first.inner.data(0), refreshed.inner.data(0));
    }

    #[test]
    #[ignore = "timing benchmark; run with --release --ignored --nocapture"]
    fn compose_timing_benchmark() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let camera = FFmpegVideoFrame {
            inner: pattern_frame(Pixel::YUV420P, 1280, 720, 5),
            timestamp,
        };
        let frames = 240u64;
        for (width, height) in [(1920, 1080), (2560, 1440), (3840, 2160)] {
            let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, width, height, 60);
            let presentation = LinuxCameraPresentation {
                shape: LinuxCameraShape::Round,
                ..LinuxCameraPresentation::default_for(width, height)
            };
            let template = pattern_frame(Pixel::BGRZ, width, height, 9);
            let run = |label: &str, converted: bool, camera_every: u64| {
                let mut compositor = Compositor::new(info, presentation);
                let mut times = Vec::new();
                for index in 0..frames {
                    let screen = FFmpegVideoFrame {
                        inner: copy_frame(&template),
                        timestamp,
                    };
                    let generation = index / camera_every;
                    let started = Instant::now();
                    let output = if converted {
                        compositor.compose_converted(&screen, &camera, generation)
                    } else {
                        compositor.compose(screen, &camera, generation)
                    };
                    times.push(started.elapsed().as_secs_f64() * 1000.0);
                    drop(output.unwrap());
                }
                times.sort_by(f64::total_cmp);
                let mean = times.iter().sum::<f64>() / times.len() as f64;
                println!(
                    "{width}x{height} {label:<34} mean {mean:6.2} ms  p50 {:6.2} ms  p95 {:6.2} ms",
                    times[times.len() / 2],
                    times[times.len() * 95 / 100],
                );
            };
            run("converted, new camera every frame", true, 1);
            run("in place, new camera every frame", false, 1);
            run("in place, 30 fps camera / 60 fps", false, 2);
        }
    }

    fn paint_rgba(frame: &mut ffmpeg::frame::Video, pixel: impl Fn(usize, usize) -> [u8; 4]) {
        let stride = frame.stride(0);
        let width = frame.width() as usize;
        let height = frame.height() as usize;
        let data = frame.data_mut(0);
        for y in 0..height {
            for x in 0..width {
                let offset = y * stride + x * 4;
                data[offset..offset + 4].copy_from_slice(&pixel(x, y));
            }
        }
    }

    fn mark_padding(frame: &mut ffmpeg::frame::Video, bytes_per_pixel: usize) {
        let stride = frame.stride(0);
        let row_bytes = frame.width() as usize * bytes_per_pixel;
        let height = frame.height() as usize;
        let data = frame.data_mut(0);
        for y in 0..height {
            let start = y * stride + row_bytes;
            let end = y * stride + stride;
            if row_bytes < stride && end <= data.len() {
                data[start..end].fill(0xA5);
            }
        }
    }

    fn formula_blend_rgba(
        destination: &mut ffmpeg::frame::Video,
        source: &ffmpeg::frame::Video,
        x: usize,
        y: usize,
    ) {
        let destination_stride = destination.stride(0);
        let source_stride = source.stride(0);
        let source_width = source.width() as usize;
        let source_height = source.height() as usize;
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
    }

    fn formula_blend_packed(
        destination: &mut ffmpeg::frame::Video,
        layout: PackedRgbLayout,
        source: &ffmpeg::frame::Video,
        x: usize,
        y: usize,
    ) {
        let bytes_per_pixel = layout.bytes_per_pixel;
        let source_stride = source.stride(0);
        let destination_stride = destination.stride(0);
        let source_width = source.width() as usize;
        let source_height = source.height() as usize;
        let source_data = source.data(0);
        let destination_data = destination.data_mut(0);
        for row in 0..source_height {
            let source_row = &source_data[row * source_stride..][..source_width * 4];
            let destination_row = &mut destination_data
                [(y + row) * destination_stride + x * bytes_per_pixel..]
                [..source_width * bytes_per_pixel];
            for (source_pixel, destination_pixel) in source_row
                .chunks_exact(4)
                .zip(destination_row.chunks_exact_mut(bytes_per_pixel))
            {
                let alpha = u16::from(source_pixel[3]);
                let inverse_alpha = 255 - alpha;
                for (channel, offset) in [layout.red, layout.green, layout.blue]
                    .into_iter()
                    .enumerate()
                {
                    destination_pixel[offset] = ((u16::from(source_pixel[channel]) * alpha
                        + u16::from(destination_pixel[offset]) * inverse_alpha
                        + 127)
                        / 255) as u8;
                }
                if let Some(opaque) = layout.opaque {
                    destination_pixel[opaque] = 255;
                }
            }
        }
    }

    fn formula_crop_camera(
        source: &ffmpeg::frame::Video,
        presentation: LinuxCameraPresentation,
        mask: &[f64],
    ) -> ffmpeg::frame::Video {
        let rect = presentation.rect;
        let crop_x = (source.width() - rect.width) as usize / 2;
        let crop_y = (source.height() - rect.height) as usize / 2;
        let mut output = ffmpeg::frame::Video::new(Pixel::RGBA, rect.width, rect.height);
        let source_stride = source.stride(0);
        let output_stride = output.stride(0);
        let source_data = source.data(0);
        let output_data = output.data_mut(0);
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
                let source_pixel = &source_data[source_offset..source_offset + 4];
                let destination = &mut output_data[output_offset..output_offset + 4];
                destination.copy_from_slice(source_pixel);
                if let Some(&coverage) = mask.get(y * rect.width as usize + x) {
                    destination[3] = (f64::from(destination[3]) * coverage).round() as u8;
                }
            }
        }
        output.set_pts(source.pts());
        output
    }

    fn opaque_pixel(x: usize, y: usize) -> [u8; 4] {
        let mixed = (x.wrapping_mul(17) + y.wrapping_mul(29)) as u8;
        [mixed, mixed.wrapping_mul(3), mixed.wrapping_add(40), 255]
    }

    fn assert_planes_equal(actual: &ffmpeg::frame::Video, expected: &ffmpeg::frame::Video) {
        assert_eq!(actual.format(), expected.format());
        assert_eq!(actual.width(), expected.width());
        assert_eq!(actual.height(), expected.height());
        assert_eq!(actual.stride(0), expected.stride(0));
        assert_eq!(actual.pts(), expected.pts());
        let layout = PackedRgbLayout::of(actual.format()).expect("packed layout");
        let row_bytes = actual.width() as usize * layout.bytes_per_pixel;
        let height = actual.height() as usize;
        let actual_data = actual.data(0);
        let expected_data = expected.data(0);
        for row in 0..height {
            let start = row * actual.stride(0);
            assert_eq!(
                &actual_data[start..start + row_bytes],
                &expected_data[start..start + row_bytes],
                "row {row}"
            );
        }
    }

    #[test]
    fn opaque_copy_blend_rgba_matches_formula() {
        ffmpeg::init().expect("FFmpeg initializes");
        for (source_width, source_height, origin_x, origin_y) in [
            (1, 1, 0, 0),
            (7, 3, 1, 2),
            (8, 2, 0, 0),
            (9, 4, 3, 1),
            (15, 2, 0, 1),
            (17, 3, 2, 0),
            (324, 2, 5, 1),
        ] {
            let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, source_width, source_height);
            source.set_pts(Some(44));
            paint_rgba(&mut source, opaque_pixel);
            mark_padding(&mut source, 4);
            let mut fast = ffmpeg::frame::Video::new(
                Pixel::RGBA,
                source_width + origin_x,
                source_height + origin_y + 2,
            );
            paint_rgba(&mut fast, |_, _| [1, 2, 3, 9]);
            mark_padding(&mut fast, 4);
            let mut slow = copy_frame(&fast);
            blend_rgba(&mut fast, &source, origin_x as usize, origin_y as usize)
                .expect("opaque rgba blend");
            formula_blend_rgba(&mut slow, &source, origin_x as usize, origin_y as usize);
            assert_planes_equal(&fast, &slow);
        }
    }

    #[test]
    fn opaque_copy_blend_packed_matches_formula() {
        ffmpeg::init().expect("FFmpeg initializes");
        let formats = [
            Pixel::BGRA,
            Pixel::BGRZ,
            Pixel::RGBA,
            Pixel::RGBZ,
            Pixel::ARGB,
            Pixel::ABGR,
            Pixel::RGB24,
            Pixel::BGR24,
        ];
        for format in formats {
            let layout = PackedRgbLayout::of(format).expect("packed layout");
            for (source_width, source_height, origin_x, origin_y) in [
                (1, 1, 0, 0),
                (7, 3, 1, 1),
                (9, 2, 0, 0),
                (17, 2, 4, 0),
                (324, 1, 1, 0),
            ] {
                let mut source =
                    ffmpeg::frame::Video::new(Pixel::RGBA, source_width, source_height);
                paint_rgba(&mut source, opaque_pixel);
                let mut fast = ffmpeg::frame::Video::new(
                    format,
                    source_width + origin_x,
                    source_height + origin_y + 1,
                );
                fast.data_mut(0).fill(17);
                mark_padding(&mut fast, layout.bytes_per_pixel);
                let mut slow = copy_frame(&fast);
                blend_rgba_into_packed(
                    &mut fast,
                    layout,
                    &source,
                    origin_x as usize,
                    origin_y as usize,
                )
                .expect("opaque packed blend");
                formula_blend_packed(
                    &mut slow,
                    layout,
                    &source,
                    origin_x as usize,
                    origin_y as usize,
                );
                assert_planes_equal(&fast, &slow);
            }
        }
    }

    #[test]
    fn opaque_copy_partial_alpha_matches_formula() {
        ffmpeg::init().expect("FFmpeg initializes");
        let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, 1, 1);
        paint_rgba(&mut source, |_, _| [10, 20, 30, 128]);
        let mut fast = ffmpeg::frame::Video::new(Pixel::RGBA, 1, 1);
        paint_rgba(&mut fast, |_, _| [1, 2, 3, 4]);
        let mut slow = copy_frame(&fast);
        blend_rgba(&mut fast, &source, 0, 0).expect("partial rgba blend");
        formula_blend_rgba(&mut slow, &source, 0, 0);
        assert_eq!(&fast.data(0)[..4], &[6, 11, 17, 255]);
        assert_planes_equal(&fast, &slow);

        let mut bgra = ffmpeg::frame::Video::new(Pixel::BGRA, 1, 1);
        paint_rgba(&mut bgra, |_, _| [1, 2, 3, 4]);
        let layout = PackedRgbLayout::of(Pixel::BGRA).expect("bgra layout");
        let mut bgra_slow = copy_frame(&bgra);
        blend_rgba_into_packed(&mut bgra, layout, &source, 0, 0).expect("partial bgra blend");
        formula_blend_packed(&mut bgra_slow, layout, &source, 0, 0);
        assert_eq!(&bgra.data(0)[..4], &[16, 11, 7, 255]);
        assert_planes_equal(&bgra, &bgra_slow);

        for (width, height) in [(7, 2), (9, 3), (17, 1), (324, 2)] {
            let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, width, height);
            paint_rgba(&mut source, |x, y| {
                let alpha = if x + 1 == width as usize && y + 1 == height as usize {
                    254
                } else {
                    ((x * 13 + y * 5) % 255) as u8
                };
                [x as u8, y as u8, alpha, alpha]
            });
            let mut rgba = ffmpeg::frame::Video::new(Pixel::RGBA, width, height);
            rgba.data_mut(0).fill(9);
            let mut rgba_slow = copy_frame(&rgba);
            blend_rgba(&mut rgba, &source, 0, 0).expect("partial rgba plane");
            formula_blend_rgba(&mut rgba_slow, &source, 0, 0);
            assert_planes_equal(&rgba, &rgba_slow);
            assert_ne!(rgba.data(0), source.data(0));

            let mut packed = ffmpeg::frame::Video::new(Pixel::BGRA, width, height);
            packed.data_mut(0).fill(9);
            let mut packed_slow = copy_frame(&packed);
            blend_rgba_into_packed(&mut packed, layout, &source, 0, 0).expect("partial bgra plane");
            formula_blend_packed(&mut packed_slow, layout, &source, 0, 0);
            assert_planes_equal(&packed, &packed_slow);
        }
    }

    #[test]
    fn opaque_copy_crop_matches_formula() {
        ffmpeg::init().expect("FFmpeg initializes");
        for (source_width, source_height, width, height, mirrored, partial) in [
            (1, 1, 1, 1, false, false),
            (7, 3, 7, 3, false, false),
            (11, 5, 7, 3, true, false),
            (9, 4, 9, 4, false, false),
            (20, 6, 17, 5, true, false),
            (324, 3, 324, 3, false, false),
            (15, 4, 9, 3, false, true),
            (16, 4, 15, 3, true, true),
        ] {
            let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, source_width, source_height);
            source.set_pts(Some(18));
            paint_rgba(&mut source, |x, y| {
                let mut pixel = opaque_pixel(x, y);
                if partial {
                    pixel[3] = ((x * 19 + y * 7) % 251) as u8;
                }
                pixel
            });
            mark_padding(&mut source, 4);
            let presentation = LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
                shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 0 },
                mirrored,
                effect: LinuxCameraEffect::None,
            };
            let actual = crop_camera(&source, presentation, &[]).expect("empty mask crop");
            let expected = formula_crop_camera(&source, presentation, &[]);
            assert_planes_equal(&actual, &expected);
            if partial {
                assert!(actual.data(0).chunks_exact(4).any(|pixel| pixel[3] != 255));
            }
        }
    }

    #[test]
    fn opaque_copy_nonempty_mask_crop_matches_formula() {
        ffmpeg::init().expect("FFmpeg initializes");
        for (width, height, radius, mirrored) in [
            (8, 8, 3, false),
            (9, 7, 2, true),
            (17, 15, 4, false),
            (15, 15, 7, true),
        ] {
            let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, width + 4, height + 2);
            source.set_pts(Some(3));
            paint_rgba(&mut source, opaque_pixel);
            let presentation = LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: 0,
                    y: 0,
                    width,
                    height,
                },
                shape: LinuxCameraShape::RoundedRectangle {
                    radius_pixels: radius,
                },
                mirrored,
                effect: LinuxCameraEffect::None,
            };
            let mask = camera_mask(presentation);
            assert!(!mask.is_empty());
            let actual = crop_camera(&source, presentation, &mask).expect("masked crop");
            let expected = formula_crop_camera(&source, presentation, &mask);
            assert_planes_equal(&actual, &expected);
            let unmasked = formula_crop_camera(
                &source,
                LinuxCameraPresentation {
                    shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 0 },
                    ..presentation
                },
                &[],
            );
            assert_ne!(
                defined_bytes(&actual),
                defined_bytes(&unmasked),
                "mask changed no pixels"
            );
        }

        let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, 5, 1);
        paint_rgba(&mut source, |x, _| [x as u8, 4, 5, 200]);
        let presentation = presentation(5, 1);
        let mask = [0.0_f64, 0.25, 1.0];
        let actual = crop_camera(&source, presentation, &mask).expect("short mask crop");
        let expected = formula_crop_camera(&source, presentation, &mask);
        assert_planes_equal(&actual, &expected);
        assert_eq!(actual.data(0)[3], 0);
        assert_eq!(actual.data(0)[7], 50);
        assert_eq!(actual.data(0)[11], 200);
        assert_eq!(actual.data(0)[19], 200);

        let mut rounding = ffmpeg::frame::Video::new(Pixel::RGBA, 4, 1);
        rounding.set_pts(Some(9));
        paint_rgba(&mut rounding, |x, _| [10 + x as u8, 20, 30, 255]);
        let rounding_mask = [0.001_f64, 0.999, 1.0, 0.5];
        for mirrored in [false, true] {
            let rounding_presentation = LinuxCameraPresentation {
                mirrored,
                rect: LinuxCameraRect {
                    x: 0,
                    y: 0,
                    width: 4,
                    height: 1,
                },
                shape: LinuxCameraShape::RoundedRectangle { radius_pixels: 0 },
                effect: LinuxCameraEffect::None,
            };
            let actual = crop_camera(&rounding, rounding_presentation, &rounding_mask)
                .expect("rounding crop");
            let expected = formula_crop_camera(&rounding, rounding_presentation, &rounding_mask);
            assert_planes_equal(&actual, &expected);
            assert_eq!(actual.data(0)[3], 0, "mirrored={mirrored}");
            assert_eq!(actual.data(0)[7], 255, "mirrored={mirrored}");
            assert_eq!(actual.data(0)[11], 255, "mirrored={mirrored}");
            assert_eq!(actual.data(0)[15], 128, "mirrored={mirrored}");
        }
    }

    #[test]
    fn opaque_copy_scalar_bgra_matches_formula() {
        for width in [1_usize, 7, 8, 9, 15, 17, 324] {
            let source: Vec<u8> = (0..width * 4)
                .map(|index| {
                    if index % 4 == 3 {
                        255
                    } else {
                        (index * 13 + 5) as u8
                    }
                })
                .collect();
            let mut scalar = vec![9_u8; width * 4];
            let mut formula = scalar.clone();
            copy_rgba_to_bgra_scalar(&source, &mut scalar);
            for (src, dst) in source.chunks_exact(4).zip(formula.chunks_exact_mut(4)) {
                let alpha = u16::from(src[3]);
                let inverse_alpha = 255 - alpha;
                let offsets = [2_usize, 1, 0];
                for (channel, offset) in offsets.into_iter().enumerate() {
                    dst[offset] = ((u16::from(src[channel]) * alpha
                        + u16::from(dst[offset]) * inverse_alpha
                        + 127)
                        / 255) as u8;
                }
                dst[3] = 255;
            }
            assert_eq!(scalar, formula, "scalar width {width}");
            assert_eq!(scalar[0], source[2]);
            assert_eq!(scalar[2], source[0]);
        }
    }

    #[test]
    #[cfg(target_arch = "x86_64")]
    fn opaque_copy_avx2_bgra_matches_scalar_fallback() {
        if !std::arch::is_x86_feature_detected!("avx2") {
            return;
        }
        for (width, height, origin_x) in [
            (1_usize, 1_usize, 0_usize),
            (7, 2, 1),
            (8, 2, 0),
            (9, 3, 3),
            (17, 2, 1),
            (324, 2, 5),
        ] {
            let row_bytes = width * 4;
            let source_stride = row_bytes + 12;
            let destination_stride = (origin_x + width) * 4 + 8;
            let mut source = vec![0_u8; source_stride * height];
            for (index, byte) in source.iter_mut().enumerate() {
                *byte = if index % 4 == 3 {
                    255
                } else {
                    (index * 19 + 3) as u8
                };
            }
            let mut avx = vec![8_u8; destination_stride * (height + 1)];
            let mut scalar = avx.clone();
            unsafe {
                copy_rgba_rows_to_bgra_avx2(
                    &mut avx,
                    &source,
                    PlaneWindow {
                        source_stride,
                        destination_stride,
                        source_x: 0,
                        source_y: 0,
                        destination_x: origin_x,
                        destination_y: 0,
                        width,
                        height,
                    },
                );
            }
            for row in 0..height {
                copy_rgba_to_bgra_scalar(
                    &source[row * source_stride..row * source_stride + row_bytes],
                    &mut scalar[row * destination_stride + origin_x * 4..][..row_bytes],
                );
            }
            assert_eq!(avx, scalar, "avx2 width {width}");
        }
    }

    fn span(start: u32, len: u32, kind: OverlaySpanKind) -> OverlaySpan {
        OverlaySpan { start, len, kind }
    }

    #[test]
    fn alpha_row_runs_cover_opaque_transparent_edge_and_ends() {
        assert_eq!(
            classify_alpha_row(&[255, 255, 255, 255]),
            vec![span(0, 4, OverlaySpanKind::Opaque)]
        );
        assert_eq!(
            classify_alpha_row(&[0, 0, 0]),
            vec![span(0, 3, OverlaySpanKind::Transparent)]
        );
        assert_eq!(
            classify_alpha_row(&[0, 0, 255, 255, 255, 40, 41, 0]),
            vec![
                span(0, 2, OverlaySpanKind::Transparent),
                span(2, 3, OverlaySpanKind::Opaque),
                span(5, 2, OverlaySpanKind::Edge),
                span(7, 1, OverlaySpanKind::Transparent),
            ]
        );
        assert_eq!(
            classify_alpha_row(&[128]),
            vec![span(0, 1, OverlaySpanKind::Edge)]
        );
        assert_eq!(
            classify_alpha_row(&[255, 255, 10, 0, 0]),
            vec![
                span(0, 2, OverlaySpanKind::Opaque),
                span(2, 1, OverlaySpanKind::Edge),
                span(3, 2, OverlaySpanKind::Transparent),
            ]
        );
        assert_eq!(
            classify_alpha_row(&[0, 12, 255, 255]),
            vec![
                span(0, 1, OverlaySpanKind::Transparent),
                span(1, 1, OverlaySpanKind::Edge),
                span(2, 2, OverlaySpanKind::Opaque),
            ]
        );
    }

    #[test]
    fn overlay_run_cache_invalidates_when_generation_or_mask_changes() {
        ffmpeg::init().expect("FFmpeg initializes");
        let mut frame = ffmpeg::frame::Video::new(Pixel::RGBA, 4, 1);
        paint_rgba(&mut frame, |_, _| [1, 2, 3, 255]);
        let mask = std::sync::Arc::<[f64]>::from(vec![1.0_f64, 0.25]);
        let mut cache = OverlayRunCache::default();
        let first = cache.resolve(1, &mask, &frame).clone();
        assert_eq!(cache.builds, 1);
        assert_eq!(first.spans, vec![span(0, 4, OverlaySpanKind::Opaque)]);

        frame.data_mut(0)[3] = 0;
        let cached = cache.resolve(1, &mask, &frame).clone();
        assert_eq!(cache.builds, 1);
        assert_eq!(cached, first);

        let rebuilt = cache.resolve(2, &mask, &frame).clone();
        assert_eq!(cache.builds, 2);
        assert_eq!(
            rebuilt.spans,
            vec![
                span(0, 1, OverlaySpanKind::Transparent),
                span(1, 3, OverlaySpanKind::Opaque),
            ]
        );

        let same_mask = std::sync::Arc::<[f64]>::from(vec![1.0_f64, 0.25]);
        let still = cache.resolve(2, &same_mask, &frame).clone();
        assert_eq!(cache.builds, 2);
        assert_eq!(still, rebuilt);

        frame.data_mut(0)[7] = 40;
        let changed_mask = std::sync::Arc::<[f64]>::from(vec![0.0_f64, 1.0]);
        let masked = cache.resolve(2, &changed_mask, &frame).clone();
        assert_eq!(cache.builds, 3);
        assert_ne!(masked, rebuilt);
        assert!(
            masked
                .spans
                .iter()
                .any(|span| span.kind == OverlaySpanKind::Edge)
        );

        let mut wider = ffmpeg::frame::Video::new(Pixel::RGBA, 5, 1);
        paint_rgba(&mut wider, |_, _| [4, 5, 6, 255]);
        cache.resolve(2, &changed_mask, &wider);
        assert_eq!(cache.builds, 4);
        assert_eq!(cache.runs.width, 5);
        cache.resolve(2, &changed_mask, &wider);
        assert_eq!(cache.builds, 4);
    }

    #[test]
    fn compositor_run_cache_invalidates_when_mask_changes() {
        ffmpeg::init().expect("FFmpeg initializes");
        let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRA, 32, 32, 30);
        let presentation = LinuxCameraPresentation {
            rect: LinuxCameraRect {
                x: 0,
                y: 0,
                width: 16,
                height: 16,
            },
            shape: LinuxCameraShape::Round,
            mirrored: false,
            effect: LinuxCameraEffect::None,
        };
        let mut compositor = Compositor::new(info, presentation);
        let camera = pattern_frame(Pixel::RGBA, 16, 16, 4);
        compositor
            .ensure_camera_overlay(&camera, 7)
            .expect("first overlay");
        assert_eq!(compositor.run_cache.builds, 1);
        let cached_runs = compositor.run_cache.runs.clone();
        compositor
            .ensure_camera_overlay(&camera, 7)
            .expect("cached overlay");
        assert_eq!(compositor.run_cache.builds, 1);
        assert_eq!(compositor.run_cache.runs, cached_runs);
        let mask = compositor.camera_mask.clone().expect("camera mask");
        assert!(!mask.is_empty());
        compositor.camera_mask = Some(std::sync::Arc::from(
            mask.iter()
                .map(|coverage| 1.0 - coverage)
                .collect::<Vec<_>>(),
        ));
        compositor
            .ensure_camera_overlay(&camera, 7)
            .expect("mask change rebuilds overlay");
        assert_eq!(compositor.run_cache.builds, 2);
        compositor
            .ensure_camera_overlay(&camera, 8)
            .expect("generation change rebuilds overlay");
        assert_eq!(compositor.run_cache.builds, 3);
    }

    #[test]
    fn opaque_round_mask_runs_are_reused_across_generations() {
        ffmpeg::init().expect("FFmpeg initializes");
        let size = 32_u32;
        let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRA, size + 4, size + 4, 30);
        for (shape, mirrored) in [
            (LinuxCameraShape::Round, false),
            (LinuxCameraShape::Round, true),
            (
                LinuxCameraShape::RoundedRectangle { radius_pixels: 8 },
                false,
            ),
        ] {
            let presentation = LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: 1,
                    y: 2,
                    width: size,
                    height: size,
                },
                shape,
                mirrored,
                effect: LinuxCameraEffect::None,
            };
            let mut compositor = Compositor::new(info, presentation);
            let mut camera = ffmpeg::frame::Video::new(Pixel::RGBA, size + 6, size + 2);
            paint_rgba(&mut camera, opaque_pixel);
            compositor
                .ensure_camera_overlay(&camera, 1)
                .expect("first overlay");
            assert_eq!(
                compositor.run_cache.builds, 1,
                "{shape:?} mirrored={mirrored}"
            );
            assert!(
                compositor
                    .run_cache
                    .key
                    .as_ref()
                    .expect("run key")
                    .from_mask,
                "{shape:?}"
            );
            let cached_runs = compositor.run_cache.runs.clone();
            assert!(
                cached_runs
                    .spans
                    .iter()
                    .any(|span| span.kind == OverlaySpanKind::Opaque),
                "{shape:?}"
            );
            assert!(
                cached_runs
                    .spans
                    .iter()
                    .any(|span| span.kind == OverlaySpanKind::Edge),
                "{shape:?}"
            );
            let mask = compositor.camera_mask.clone().expect("mask");
            let scaled = compositor
                .convert_camera(&camera, size, size)
                .expect("scale camera");
            let overlay = &compositor.camera_overlay.as_ref().expect("overlay").1;
            assert_eq!(overlay_runs(overlay).spans, cached_runs.spans);
            assert_planes_equal(
                overlay,
                &formula_crop_camera(&scaled, presentation, mask.as_ref()),
            );
            let first_pixels = overlay.data(0).to_vec();

            paint_rgba(&mut camera, |x, y| opaque_pixel(x + 5, y + 1));
            compositor
                .ensure_camera_overlay(&camera, 2)
                .expect("next generation");
            assert_eq!(
                compositor.run_cache.builds, 1,
                "{shape:?} mirrored={mirrored}"
            );
            assert_eq!(compositor.run_cache.runs, cached_runs);
            let scaled = compositor
                .convert_camera(&camera, size, size)
                .expect("scale next camera");
            let overlay = &compositor.camera_overlay.as_ref().expect("overlay").1;
            assert_planes_equal(
                overlay,
                &formula_crop_camera(&scaled, presentation, mask.as_ref()),
            );
            assert_ne!(overlay.data(0), first_pixels.as_slice());
            assert_eq!(overlay_runs(overlay).spans, cached_runs.spans);

            paint_rgba(&mut camera, |x, y| {
                let mut pixel = opaque_pixel(x, y);
                pixel[3] = 180;
                pixel
            });
            compositor
                .ensure_camera_overlay(&camera, 3)
                .expect("partial alpha");
            assert_eq!(
                compositor.run_cache.builds, 2,
                "{shape:?} mirrored={mirrored}"
            );
            assert!(
                !compositor
                    .run_cache
                    .key
                    .as_ref()
                    .expect("run key")
                    .from_mask
            );
            let scaled = compositor
                .convert_camera(&camera, size, size)
                .expect("scale partial camera");
            let overlay = &compositor.camera_overlay.as_ref().expect("overlay").1;
            assert_planes_equal(
                overlay,
                &formula_crop_camera(&scaled, presentation, mask.as_ref()),
            );
        }
    }

    #[test]
    fn shaped_overlay_blend_matches_formula() {
        ffmpeg::init().expect("FFmpeg initializes");
        let cases = [
            (17_u32, LinuxCameraShape::Round),
            (17, LinuxCameraShape::RoundedRectangle { radius_pixels: 4 }),
            (48, LinuxCameraShape::RoundedRectangle { radius_pixels: 24 }),
        ];
        for (size, shape) in cases {
            let mut camera = ffmpeg::frame::Video::new(Pixel::RGBA, size, size);
            paint_rgba(&mut camera, opaque_pixel);
            let presentation = LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: 1,
                    y: 2,
                    width: size,
                    height: size,
                },
                shape,
                mirrored: false,
                effect: LinuxCameraEffect::None,
            };
            let mask = camera_mask(presentation);
            assert!(!mask.is_empty(), "{shape:?}");
            let overlay = crop_camera(&camera, presentation, &mask).expect("shaped overlay");
            let runs = overlay_runs(&overlay);
            assert!(
                runs.spans
                    .iter()
                    .any(|span| span.kind == OverlaySpanKind::Opaque),
                "{shape:?} opaque"
            );
            assert!(
                runs.spans
                    .iter()
                    .any(|span| span.kind == OverlaySpanKind::Transparent),
                "{shape:?} transparent"
            );
            assert!(
                runs.spans
                    .iter()
                    .any(|span| span.kind == OverlaySpanKind::Edge),
                "{shape:?} edge"
            );
            let origin_x = 1_usize;
            let origin_y = 2_usize;
            let mut rgba = ffmpeg::frame::Video::new(Pixel::RGBA, size + 3, size + 4);
            rgba.data_mut(0).fill(9);
            mark_padding(&mut rgba, 4);
            let mut rgba_formula = copy_frame(&rgba);
            blend_rgba_with_runs(&mut rgba, &overlay, origin_x, origin_y, Some(&runs))
                .expect("rgba runs blend");
            formula_blend_rgba(&mut rgba_formula, &overlay, origin_x, origin_y);
            assert_planes_equal(&rgba, &rgba_formula);

            let mut bgra = ffmpeg::frame::Video::new(Pixel::BGRA, size + 3, size + 4);
            bgra.data_mut(0).fill(9);
            mark_padding(&mut bgra, 4);
            let mut bgra_formula = copy_frame(&bgra);
            let layout = PackedRgbLayout::of(Pixel::BGRA).expect("bgra layout");
            blend_rgba_into_packed_with_runs(
                &mut bgra,
                layout,
                &overlay,
                origin_x,
                origin_y,
                Some(&runs),
            )
            .expect("bgra runs blend");
            formula_blend_packed(&mut bgra_formula, layout, &overlay, origin_x, origin_y);
            assert_planes_equal(&bgra, &bgra_formula);
        }
    }

    fn median_nanos(samples: &mut [u128]) -> u128 {
        samples.sort_unstable();
        samples[samples.len() / 2]
    }

    fn previous_blend_rgba(
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
        if rgba_plane_is_opaque(source_data, source_stride, source_width, source_height) {
            copy_rgba_rows(
                destination_data,
                source_data,
                PlaneWindow {
                    source_stride,
                    destination_stride,
                    source_x: 0,
                    source_y: 0,
                    destination_x: x,
                    destination_y: y,
                    width: source_width,
                    height: source_height,
                },
            );
            return Ok(());
        }
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

    fn previous_blend_rgba_into_packed(
        destination: &mut ffmpeg::frame::Video,
        layout: PackedRgbLayout,
        source: &ffmpeg::frame::Video,
        x: usize,
        y: usize,
    ) -> anyhow::Result<()> {
        if source.format() != Pixel::RGBA {
            return Err(anyhow!("camera overlay must be RGBA"));
        }
        let source_width = source.width() as usize;
        let source_height = source.height() as usize;
        if x.saturating_add(source_width) > destination.width() as usize
            || y.saturating_add(source_height) > destination.height() as usize
        {
            return Err(anyhow!("camera overlay exceeds screen frame"));
        }
        let bytes_per_pixel = layout.bytes_per_pixel;
        let source_stride = source.stride(0);
        let destination_stride = destination.stride(0);
        let source_data = source.data(0);
        let destination_data = destination.data_mut(0);
        if rgba_plane_is_opaque(source_data, source_stride, source_width, source_height)
            && rgba_rows_fit(
                destination_data.len(),
                destination_stride,
                x * bytes_per_pixel,
                source_width * bytes_per_pixel,
                y,
                source_height,
            )
        {
            copy_opaque_rgba_into_packed(
                destination_data,
                source_data,
                PlaneWindow {
                    source_stride,
                    destination_stride,
                    source_x: 0,
                    source_y: 0,
                    destination_x: x,
                    destination_y: y,
                    width: source_width,
                    height: source_height,
                },
                layout,
            );
            return Ok(());
        }
        for row in 0..source_height {
            let source_row = &source_data[row * source_stride..][..source_width * 4];
            let destination_row = &mut destination_data
                [(y + row) * destination_stride + x * bytes_per_pixel..]
                [..source_width * bytes_per_pixel];
            for (source_pixel, destination_pixel) in source_row
                .chunks_exact(4)
                .zip(destination_row.chunks_exact_mut(bytes_per_pixel))
            {
                let alpha = u16::from(source_pixel[3]);
                let inverse_alpha = 255 - alpha;
                for (channel, offset) in [layout.red, layout.green, layout.blue]
                    .into_iter()
                    .enumerate()
                {
                    destination_pixel[offset] = ((u16::from(source_pixel[channel]) * alpha
                        + u16::from(destination_pixel[offset]) * inverse_alpha
                        + 127)
                        / 255) as u8;
                }
                if let Some(opaque) = layout.opaque {
                    destination_pixel[opaque] = 255;
                }
            }
        }
        Ok(())
    }

    fn span_pixel_counts(runs: &OverlayRuns) -> (u64, u64, u64) {
        let mut opaque = 0_u64;
        let mut transparent = 0_u64;
        let mut edge = 0_u64;
        for span in &runs.spans {
            let len = u64::from(span.len);
            match span.kind {
                OverlaySpanKind::Opaque => opaque += len,
                OverlaySpanKind::Transparent => transparent += len,
                OverlaySpanKind::Edge => edge += len,
            }
        }
        (opaque, transparent, edge)
    }

    struct BenchRect {
        x: usize,
        y: usize,
        width: usize,
        height: usize,
    }

    fn copy_overlay_rect(
        destination: &mut ffmpeg::frame::Video,
        template: &ffmpeg::frame::Video,
        rect: &BenchRect,
    ) {
        let bytes_per_pixel = PackedRgbLayout::of(destination.format())
            .expect("packed layout")
            .bytes_per_pixel;
        let row_bytes = rect.width * bytes_per_pixel;
        let destination_stride = destination.stride(0);
        let template_stride = template.stride(0);
        let template_data = template.data(0);
        let destination_data = destination.data_mut(0);
        for row in 0..rect.height {
            let source_offset = (rect.y + row) * template_stride + rect.x * bytes_per_pixel;
            let destination_offset = (rect.y + row) * destination_stride + rect.x * bytes_per_pixel;
            destination_data[destination_offset..destination_offset + row_bytes]
                .copy_from_slice(&template_data[source_offset..source_offset + row_bytes]);
        }
    }

    fn time_overlay(
        template: &ffmpeg::frame::Video,
        rect: &BenchRect,
        warmup: usize,
        runs: usize,
        mut blend: impl FnMut(&mut ffmpeg::frame::Video),
    ) -> (u128, u128, u128) {
        let mut frame = copy_frame(template);
        for _ in 0..warmup {
            blend(&mut frame);
            copy_overlay_rect(&mut frame, template, rect);
        }
        let mut samples = Vec::with_capacity(runs);
        for _ in 0..runs {
            copy_overlay_rect(&mut frame, template, rect);
            let started = Instant::now();
            blend(std::hint::black_box(&mut frame));
            let _ = std::hint::black_box(frame.data(0)[rect.y * frame.stride(0) + rect.x]);
            samples.push(started.elapsed().as_nanos());
        }
        let min = samples.iter().copied().min().unwrap_or(0);
        let max = samples.iter().copied().max().unwrap_or(0);
        (min, median_nanos(&mut samples), max)
    }

    fn print_overlay_time(label: &str, sample: (u128, u128, u128)) {
        let millis = |nanos: u128| nanos as f64 / 1_000_000.0;
        println!(
            "{label} median_ms={:.4} min_ms={:.4} max_ms={:.4}",
            millis(sample.1),
            millis(sample.0),
            millis(sample.2),
        );
    }

    #[test]
    #[ignore = "release timing benchmark; run with --release --ignored --nocapture"]
    fn opaque_copy_benchmark() {
        ffmpeg::init().expect("FFmpeg initializes");
        const WARMUP: usize = 2;
        const RUNS: usize = 11;
        let screen_width = 1920_u32;
        let screen_height = 1080_u32;
        let (origin_x, origin_y, size) = overlay_rect(screen_width, screen_height);
        assert_eq!(size, 324);
        println!(
            "opaque_copy_bench screen={screen_width}x{screen_height} camera={size}x{size} origin={origin_x},{origin_y} warmup={WARMUP} runs={RUNS} median"
        );
        let shapes = [
            ("round", LinuxCameraShape::Round),
            (
                "square_r24",
                LinuxCameraShape::RoundedRectangle { radius_pixels: 24 },
            ),
            (
                "rounded_rectangle_r64",
                LinuxCameraShape::RoundedRectangle { radius_pixels: 64 },
            ),
        ];
        for (name, shape) in shapes {
            let mut camera = ffmpeg::frame::Video::new(Pixel::RGBA, size, size);
            paint_rgba(&mut camera, opaque_pixel);
            let presentation = LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: origin_x as u32,
                    y: origin_y as u32,
                    width: size,
                    height: size,
                },
                shape,
                mirrored: false,
                effect: LinuxCameraEffect::None,
            };
            presentation
                .validate(screen_width, screen_height)
                .expect("presentation fits");
            let mask = camera_mask(presentation);
            assert!(!mask.is_empty(), "{name}");
            let overlay = crop_camera(&camera, presentation, &mask).expect("shaped overlay");
            let started = Instant::now();
            let runs = overlay_runs(&overlay);
            let runs_ms = started.elapsed().as_secs_f64() * 1000.0;
            let (opaque, transparent, edge) = span_pixel_counts(&runs);
            println!(
                "presentation={name} radius={:.1} runs_build_ms={runs_ms:.4} opaque={opaque} transparent={transparent} edge={edge}",
                presentation.radius()
            );
            for (format_name, format) in [("bgra", Pixel::BGRA), ("rgba", Pixel::RGBA)] {
                let layout = PackedRgbLayout::of(format).expect("packed layout");
                let template = pattern_frame(format, screen_width, screen_height, 9);
                let mut original = copy_frame(&template);
                let mut previous = copy_frame(&template);
                let mut rework = copy_frame(&template);
                if format == Pixel::RGBA {
                    formula_blend_rgba(&mut original, &overlay, origin_x, origin_y);
                    previous_blend_rgba(&mut previous, &overlay, origin_x, origin_y)
                        .expect("previous rgba");
                    blend_rgba_with_runs(&mut rework, &overlay, origin_x, origin_y, Some(&runs))
                        .expect("rework rgba");
                } else {
                    formula_blend_packed(&mut original, layout, &overlay, origin_x, origin_y);
                    previous_blend_rgba_into_packed(
                        &mut previous,
                        layout,
                        &overlay,
                        origin_x,
                        origin_y,
                    )
                    .expect("previous bgra");
                    blend_rgba_into_packed_with_runs(
                        &mut rework,
                        layout,
                        &overlay,
                        origin_x,
                        origin_y,
                        Some(&runs),
                    )
                    .expect("rework bgra");
                }
                assert_planes_equal(&previous, &original);
                assert_planes_equal(&rework, &original);
                let rect = BenchRect {
                    x: origin_x,
                    y: origin_y,
                    width: size as usize,
                    height: size as usize,
                };
                let original_time = time_overlay(&template, &rect, WARMUP, RUNS, |frame| {
                    if format == Pixel::RGBA {
                        formula_blend_rgba(
                            frame,
                            std::hint::black_box(&overlay),
                            origin_x,
                            origin_y,
                        );
                    } else {
                        formula_blend_packed(
                            frame,
                            layout,
                            std::hint::black_box(&overlay),
                            origin_x,
                            origin_y,
                        );
                    }
                });
                let previous_time = time_overlay(&template, &rect, WARMUP, RUNS, |frame| {
                    if format == Pixel::RGBA {
                        previous_blend_rgba(
                            frame,
                            std::hint::black_box(&overlay),
                            origin_x,
                            origin_y,
                        )
                        .expect("timed previous rgba");
                    } else {
                        previous_blend_rgba_into_packed(
                            frame,
                            layout,
                            std::hint::black_box(&overlay),
                            origin_x,
                            origin_y,
                        )
                        .expect("timed previous bgra");
                    }
                });
                let rework_time = time_overlay(&template, &rect, WARMUP, RUNS, |frame| {
                    if format == Pixel::RGBA {
                        blend_rgba_with_runs(
                            frame,
                            std::hint::black_box(&overlay),
                            origin_x,
                            origin_y,
                            Some(std::hint::black_box(&runs)),
                        )
                        .expect("timed rework rgba");
                    } else {
                        blend_rgba_into_packed_with_runs(
                            frame,
                            layout,
                            std::hint::black_box(&overlay),
                            origin_x,
                            origin_y,
                            Some(std::hint::black_box(&runs)),
                        )
                        .expect("timed rework bgra");
                    }
                });
                let prefix = format!("presentation={name} format={format_name} algo");
                print_overlay_time(&format!("{prefix}=original"), original_time);
                print_overlay_time(&format!("{prefix}=previous"), previous_time);
                print_overlay_time(&format!("{prefix}=rework"), rework_time);
            }
        }
    }

    fn time_crop(warmup: usize, runs: usize, mut crop: impl FnMut()) -> (u128, u128, u128) {
        for _ in 0..warmup {
            crop();
        }
        let mut samples = Vec::with_capacity(runs);
        for _ in 0..runs {
            let started = Instant::now();
            crop();
            samples.push(started.elapsed().as_nanos());
        }
        let min = samples.iter().copied().min().unwrap_or(0);
        let max = samples.iter().copied().max().unwrap_or(0);
        (min, median_nanos(&mut samples), max)
    }

    #[test]
    #[ignore = "release timing benchmark; run with --release --ignored --nocapture"]
    fn crop_run_timing_benchmark() {
        ffmpeg::init().expect("FFmpeg initializes");
        const WARMUP: usize = 20;
        const RUNS: usize = 101;
        println!("crop_run_bench warmup={WARMUP} runs={RUNS} median");
        for size in [230_u32, 324, 460, 648] {
            let mut source = ffmpeg::frame::Video::new(Pixel::RGBA, size, size);
            source.set_pts(Some(1));
            paint_rgba(&mut source, opaque_pixel);
            let presentation = LinuxCameraPresentation {
                rect: LinuxCameraRect {
                    x: 0,
                    y: 0,
                    width: size,
                    height: size,
                },
                shape: LinuxCameraShape::Round,
                mirrored: false,
                effect: LinuxCameraEffect::None,
            };
            let mask = camera_mask(presentation);
            let started = Instant::now();
            let runs = mask_overlay_runs(&mask, size as usize, size as usize);
            let build_ms = started.elapsed().as_secs_f64() * 1000.0;
            let (opaque, transparent, edge) = span_pixel_counts(&runs);
            let (cached, applied) =
                crop_camera_with_runs(&source, presentation, &mask, Some(&runs))
                    .expect("cached crop");
            assert!(applied);
            assert_planes_equal(&cached, &formula_crop_camera(&source, presentation, &mask));
            println!(
                "size={size} runs_build_ms={build_ms:.4} opaque={opaque} transparent={transparent} edge={edge}"
            );
            let millis = |nanos: u128| nanos as f64 / 1_000_000.0;
            let print_sample = |algo: &str, sample: (u128, u128, u128)| {
                println!(
                    "size={size} algo={algo} median_ms={:.4} min_ms={:.4} max_ms={:.4}",
                    millis(sample.1),
                    millis(sample.0),
                    millis(sample.2),
                );
            };
            print_sample(
                "scalar",
                time_crop(WARMUP, RUNS, || {
                    let output = formula_crop_camera(
                        std::hint::black_box(&source),
                        presentation,
                        std::hint::black_box(&mask),
                    );
                    std::hint::black_box(output.data(0)[size as usize / 2 * output.stride(0)]);
                }),
            );
            print_sample(
                "cached_runs",
                time_crop(WARMUP, RUNS, || {
                    let (output, applied) = crop_camera_with_runs(
                        std::hint::black_box(&source),
                        presentation,
                        std::hint::black_box(&mask),
                        Some(std::hint::black_box(&runs)),
                    )
                    .expect("timed cached crop");
                    assert!(applied);
                    std::hint::black_box(output.data(0)[size as usize / 2 * output.stride(0)]);
                }),
            );
            print_sample(
                "rebuild_runs",
                time_crop(WARMUP, RUNS, || {
                    let output = crop_camera(
                        std::hint::black_box(&source),
                        presentation,
                        std::hint::black_box(&mask),
                    )
                    .expect("timed rebuild crop");
                    std::hint::black_box(output.data(0)[size as usize / 2 * output.stride(0)]);
                }),
            );
        }
    }
}
