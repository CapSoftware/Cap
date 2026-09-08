//! App-scoped device feeds -- the gpui counterpart of the Tauri `App` state's
//! `camera_feed` / `mic_feed`.
//!
//! Selecting a camera spins the feed up and opens the preview window
//! immediately, before any recording exists; selecting a microphone keeps a
//! meter running so the pickers and the recording bar can show a live level.
//! A recording then locks the *already running* feeds (`feeds::camera::Lock` /
//! `feeds::microphone::Lock`), exactly like `src-tauri/src/recording.rs`.
//!
//! Threading: kameo actors live on the tokio runtime, so every actor message
//! goes through `gpui_tokio::Tokio::spawn`. Frame and sample pumps await their
//! flume channels on the foreground executor -- each frame has to land on the
//! main thread anyway to repaint, so draining there avoids a second hop.

use std::time::{Duration, Instant};

use std::sync::Arc;
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::{AtomicBool, AtomicU8};
use std::sync::atomic::{AtomicU64, Ordering};

use cap_recording::feeds::{
    camera::{self, CameraFeed},
    microphone::{self, MicrophoneFeed, MicrophoneSamples},
};
use futures_util::{
    FutureExt as _,
    future::{BoxFuture, Shared},
};
use gpui::{App, AppContext as _, Context, Entity, Global};
use kameo::{Actor as _, actor::ActorRef};

pub use cap_recording::feeds::camera::DeviceOrModelID;

pub type InputReady =
    Shared<BoxFuture<'static, Result<crate::store::RecordingDeviceSettings, String>>>;

#[derive(Clone, Default)]
pub struct InputReadiness {
    pub camera: Option<InputReady>,
    pub microphone: Option<InputReady>,
}

fn owned_input_readiness(
    input: impl std::future::Future<Output = Result<crate::store::RecordingDeviceSettings, String>>
    + Send
    + 'static,
    current_epoch: Arc<AtomicU64>,
    epoch: u64,
) -> InputReady {
    async move {
        let result = input.await;
        if current_epoch.load(Ordering::Acquire) != epoch {
            return Err("Device selection changed before it was ready".to_string());
        }
        result
    }
    .boxed()
    .shared()
}

use crate::app_windows;

#[cfg(target_os = "macos")]
type PreviewCameraFrame = cap_recording::NativeCameraFrame;
#[cfg(not(target_os = "macos"))]
type PreviewCameraFrame = cap_recording::FFmpegVideoFrame;

async fn attach_camera_preview_sender(
    actor: &ActorRef<CameraFeed>,
    sender: &flume::Sender<PreviewCameraFrame>,
) -> Result<(), String> {
    if sender.is_disconnected() {
        return Err("Camera preview worker is unavailable".to_string());
    }
    #[cfg(target_os = "macos")]
    let result = actor.ask(camera::AddNativeSender(sender.clone())).await;
    #[cfg(not(target_os = "macos"))]
    let result = actor.ask(camera::AddSender(sender.clone())).await;
    result.map_err(|error| error.to_string())
}

async fn camera_input_operation<T>(
    gate: &tokio::sync::Mutex<()>,
    current_epoch: &AtomicU64,
    epoch: u64,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<Option<T>, String> {
    let _operation = gate.lock().await;
    if current_epoch.load(Ordering::Acquire) != epoch {
        return Ok(None);
    }
    operation.await.map(Some)
}

fn configuration_result(
    current_epoch: u64,
    epoch: u64,
    pending: bool,
    error: Option<&str>,
) -> Option<Result<(), String>> {
    if current_epoch != epoch {
        Some(Err(
            "Device selection changed before the format was applied".into(),
        ))
    } else if pending {
        None
    } else {
        Some(error.map_or(Ok(()), |error| Err(error.to_string())))
    }
}

/// How the pickers map dB to a 0..1 bar: `DeviceListPanel` in `index.tsx`
/// (`DB_SCALE = 40`, inverted, square-rooted). 1 = silence, 0 = full scale --
/// the overlay's `right` offset, kept in the same orientation as the web app.
pub fn picker_level(db: f64) -> f64 {
    (1.0 - ((db + 40.0).max(0.0) / 40.0)).max(0.0).sqrt()
}

/// How the recording bar maps dB to its little track: `createAudioInputLevel`
/// in `in-progress-recording.tsx` (-60..0 dB, linear, 0 = silence).
pub fn bar_level(db: f64) -> f64 {
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

#[cfg(not(target_os = "macos"))]
enum CameraWorkerCommand {
    Reset,
    #[cfg(target_os = "linux")]
    Record(RecordingCameraWorker),
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct CameraProcessingFactory {
    commands: flume::Sender<CameraWorkerCommand>,
    actor: ActorRef<CameraFeed>,
    selected: DeviceOrModelID,
    epoch: u64,
    current_epoch: Arc<std::sync::atomic::AtomicU64>,
    recording_active: Arc<AtomicBool>,
    next_generation: Arc<std::sync::atomic::AtomicU64>,
}

#[cfg(target_os = "linux")]
struct CameraRecordingReservation(Arc<AtomicBool>);

#[cfg(target_os = "linux")]
impl CameraRecordingReservation {
    fn try_acquire(active: &Arc<AtomicBool>) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(active.clone()))
    }
}

#[cfg(target_os = "linux")]
impl Drop for CameraRecordingReservation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "linux")]
struct RecordingCameraAttachment {
    feed: ActorRef<CameraFeed>,
    sender: flume::Sender<cap_recording::FFmpegVideoFrame>,
    runtime: tokio::runtime::Handle,
    _reservation: CameraRecordingReservation,
}

#[cfg(target_os = "linux")]
impl Drop for RecordingCameraAttachment {
    fn drop(&mut self) {
        let feed = self.feed.clone();
        let sender = self.sender.clone();
        drop(self.runtime.spawn(async move {
            let _ = feed.ask(camera::RemoveSender(sender)).await;
        }));
    }
}

#[cfg(target_os = "linux")]
struct RecordingCameraWorker {
    frames: flume::Receiver<cap_recording::FFmpegVideoFrame>,
    publisher: cap_recording::instant_recording::LinuxCameraPublisher,
    processing: cap_recording::instant_recording::LinuxCameraProcessing,
    epoch: u64,
    current_epoch: Arc<std::sync::atomic::AtomicU64>,
    generation: u64,
    not_before: Instant,
    _attachment: RecordingCameraAttachment,
}

#[cfg(target_os = "linux")]
impl CameraProcessingFactory {
    pub async fn subscribe(
        &self,
        feed: Arc<camera::CameraFeedLock>,
        processing: cap_recording::instant_recording::LinuxCameraProcessing,
    ) -> anyhow::Result<cap_recording::instant_recording::LinuxProcessedCameraSource> {
        let info = feed.camera_info();
        let matches = match &self.selected {
            DeviceOrModelID::DeviceID(id) => info.device_id() == id,
            DeviceOrModelID::ModelID(id) => info.model_id() == Some(id),
        };
        anyhow::ensure!(
            matches && feed.id() == self.actor.id(),
            "Processed camera factory does not match the locked camera"
        );
        anyhow::ensure!(
            self.current_epoch.load(Ordering::Acquire) == self.epoch,
            "Camera selection changed before recording"
        );
        let reservation = tokio::time::timeout(Duration::from_millis(1500), async {
            loop {
                if let Some(reservation) =
                    CameraRecordingReservation::try_acquire(&self.recording_active)
                {
                    break reservation;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("A processed camera recording is already active"))?;
        let (sender, frames) = flume::bounded(2);
        let attachment = RecordingCameraAttachment {
            feed: self.actor.clone(),
            sender: sender.clone(),
            runtime: tokio::runtime::Handle::current(),
            _reservation: reservation,
        };
        anyhow::ensure!(
            self.current_epoch.load(Ordering::Acquire) == self.epoch,
            "Camera selection changed while waiting for recording processing"
        );
        let not_before = Instant::now();
        let generation = self.next_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let (publisher, mut source) =
            cap_recording::instant_recording::LinuxProcessedCameraSource::channel(
                feed.clone(),
                processing,
                generation,
                not_before,
            );
        tokio::time::timeout(
            Duration::from_millis(1500),
            feed.ask(camera::AddSender(sender)),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Timed out attaching processed camera"))?
        .map_err(|error| anyhow::anyhow!("Attaching processed camera: {error}"))?;
        tokio::time::timeout(
            Duration::from_millis(1500),
            self.commands
                .send_async(CameraWorkerCommand::Record(RecordingCameraWorker {
                    frames,
                    publisher,
                    processing,
                    epoch: self.epoch,
                    current_epoch: self.current_epoch.clone(),
                    generation,
                    not_before,
                    _attachment: attachment,
                })),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Camera processing worker command deadline exceeded"))?
        .map_err(|_| anyhow::anyhow!("Camera preview processing worker is unavailable"))?;
        source.wait_ready(Duration::from_secs(10)).await?;
        anyhow::ensure!(
            self.current_epoch.load(Ordering::Acquire) == self.epoch,
            "Camera selection changed while preparing recording effects"
        );
        Ok(source)
    }
}

#[cfg(target_os = "linux")]
impl RecordingCameraWorker {
    fn publish(
        &self,
        image: &gpui::RenderImage,
        dims: (usize, usize),
        timestamp: cap_timestamp::Timestamp,
        mask: Option<cap_recording::instant_recording::LinuxCameraMaskReceipt>,
    ) {
        if self.publisher.is_cancelled() {
            return;
        }
        match validate_recording_camera_frame(
            timestamp,
            self.not_before,
            self.epoch,
            self.current_epoch.load(Ordering::Acquire),
        ) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                self.publisher.fail(error);
                return;
            }
        }
        let Some(bytes) = image.as_bytes(0) else {
            self.publisher
                .fail("Processed camera pixels unavailable".to_string());
            return;
        };
        self.publisher.publish(
            cap_recording::instant_recording::LinuxProcessedCameraFrame {
                bgra: Arc::from(bytes),
                dimensions: (dims.0 as u32, dims.1 as u32),
                stride: dims.0 * 4,
                timestamp,
                generation: self.generation,
                processing: self.processing,
                mask,
            },
        );
    }
}

#[cfg(target_os = "linux")]
fn validate_recording_camera_frame(
    timestamp: cap_timestamp::Timestamp,
    not_before: Instant,
    epoch: u64,
    current_epoch: u64,
) -> Result<bool, String> {
    if epoch != current_epoch {
        return Err("Camera selection changed during recording".to_string());
    }
    let cap_timestamp::Timestamp::Instant(captured_at) = timestamp else {
        return Err("Camera capture timestamp is not monotonic".to_string());
    };
    Ok(captured_at >= not_before)
}

#[cfg(target_os = "linux")]
fn checked_recording_blur(
    status: &cap_camera_effects::BlurOutputStatus,
    expected_mode: cap_camera_effects::BlurMode,
    dimensions: (u32, u32),
    now: Instant,
) -> Result<Option<cap_recording::instant_recording::LinuxCameraMaskReceipt>, String> {
    match status.applied_at(
        now,
        cap_recording::instant_recording::LINUX_CAMERA_MAX_MASK_AGE,
    ) {
        Ok(applied) if applied.mode == expected_mode && applied.output_dimensions == dimensions => {
            Ok(Some(
                cap_recording::instant_recording::LinuxCameraMaskReceipt {
                    generation: applied.mask.generation,
                    submitted_at: applied.mask.input_submitted_at,
                    completed_at: applied.mask.inference_completed_at,
                },
            ))
        }
        Err(cap_camera_effects::BlurOutputUnavailable::Pending) => Ok(None),
        other => Err(format!("Requested camera blur was not applied: {other:?}")),
    }
}

#[cfg(target_os = "linux")]
fn frozen_processing_state(
    processing: cap_recording::instant_recording::LinuxCameraProcessing,
) -> (u8, bool) {
    use cap_recording::instant_recording::LinuxCameraBlur;
    (
        match processing.blur {
            LinuxCameraBlur::Off => 0,
            LinuxCameraBlur::Light => 1,
            LinuxCameraBlur::Heavy => 2,
        },
        processing.mirrored,
    )
}

#[cfg(not(target_os = "macos"))]
struct CameraPreviewWorkerConfig {
    frames: flume::Receiver<cap_recording::FFmpegVideoFrame>,
    previews: flume::Sender<crate::camera_window::CameraPreviewFrame>,
    commands: flume::Receiver<CameraWorkerCommand>,
    mirrored: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    blur: Arc<AtomicU8>,
}

#[cfg(not(target_os = "macos"))]
fn run_camera_preview_worker(config: CameraPreviewWorkerConfig) {
    let CameraPreviewWorkerConfig {
        frames: frame_rx,
        previews: preview_tx,
        commands: reset_rx,
        mirrored,
        active,
        blur,
    } = config;
    let mut scaler = None;
    let mut processor = None;
    let mut previous_blur = 0;
    let mut blur_failed = false;
    #[cfg(target_os = "linux")]
    let mut recording: Option<RecordingCameraWorker> = None;
    loop {
        #[cfg(target_os = "linux")]
        if recording
            .as_ref()
            .is_some_and(|recording| recording.publisher.is_cancelled())
        {
            recording = None;
            scaler = None;
            processor = None;
            previous_blur = 0;
            blur_failed = false;
        }
        enum Event {
            Frame(Result<cap_recording::FFmpegVideoFrame, flume::RecvError>),
            Command(Result<CameraWorkerCommand, flume::RecvError>),
        }
        let input = &frame_rx;
        #[cfg(target_os = "linux")]
        let input = recording
            .as_ref()
            .map_or(input, |recording| &recording.frames);
        let selector = flume::Selector::new()
            .recv(input, Event::Frame)
            .recv(&reset_rx, Event::Command);
        #[cfg(target_os = "linux")]
        let poll_cancellation = recording.is_some();
        #[cfg(not(target_os = "linux"))]
        let poll_cancellation = false;
        let event = if poll_cancellation {
            selector.wait_timeout(Duration::from_millis(50)).ok()
        } else {
            Some(selector.wait())
        };
        let mut frame = match event {
            Some(Event::Frame(Ok(frame))) => frame,
            Some(Event::Command(Ok(command))) => {
                match command {
                    CameraWorkerCommand::Reset =>
                    {
                        #[cfg(target_os = "linux")]
                        if let Some(recording) = &recording {
                            recording
                                .publisher
                                .fail("Camera preview was reset during recording".to_string());
                        }
                    }
                    #[cfg(target_os = "linux")]
                    CameraWorkerCommand::Record(next) => {
                        if recording.is_some() {
                            next.publisher
                                .fail("Another processed camera lease is still active".to_string());
                            continue;
                        }
                        recording = Some(next);
                    }
                }
                scaler = None;
                processor = None;
                previous_blur = 0;
                blur_failed = false;
                continue;
            }
            Some(Event::Frame(Err(_)) | Event::Command(Err(_))) => break,
            None => continue,
        };
        let processing_active = active.load(Ordering::Acquire);
        #[cfg(target_os = "linux")]
        let processing_active = processing_active || recording.is_some();
        if !processing_active {
            continue;
        }
        while let Ok(newer) = input.try_recv() {
            frame = newer;
        }
        let requested_blur = blur.load(Ordering::Relaxed);
        let requested_mirror = mirrored.load(Ordering::Relaxed);
        #[cfg(target_os = "linux")]
        let (requested_blur, requested_mirror) = if let Some(recording) = &recording {
            match validate_recording_camera_frame(
                frame.timestamp,
                recording.not_before,
                recording.epoch,
                recording.current_epoch.load(Ordering::Acquire),
            ) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    recording.publisher.fail(error);
                    continue;
                }
            }
            frozen_processing_state(recording.processing)
        } else {
            (requested_blur, requested_mirror)
        };
        if requested_blur != previous_blur {
            processor = None;
            blur_failed = false;
            previous_blur = requested_blur;
        }
        let blur_mode = match requested_blur {
            1 => Some(cap_camera_effects::BlurMode::Light),
            2 => Some(cap_camera_effects::BlurMode::Heavy),
            _ => None,
        }
        .filter(|_| !blur_failed && crate::camera_blur_portable::blur_allowed());
        #[cfg(target_os = "linux")]
        if requested_blur != 0
            && blur_mode.is_none()
            && let Some(recording) = &recording
        {
            recording
                .publisher
                .fail("Requested camera blur is unavailable".to_string());
        }
        let max_dims = blur_mode.map(|_| crate::camera_blur_portable::MAX_DIMS);
        let Some((mut image, dims)) =
            camera_preview_image(&frame.inner, &mut scaler, requested_mirror, max_dims)
        else {
            #[cfg(target_os = "linux")]
            if let Some(recording) = &recording {
                recording
                    .publisher
                    .fail("Camera frame conversion failed".to_string());
            }
            continue;
        };
        #[cfg(target_os = "linux")]
        let mut applied_mask = None;
        #[cfg(target_os = "linux")]
        let mut effects_ready = requested_blur == 0;
        if let Some(mode) = blur_mode
            && !blur_failed
        {
            if processor.is_none() {
                match crate::camera_blur_portable::PortableCameraBlur::new() {
                    Ok(worker) => {
                        tracing::info!("camera blur preview initialized");
                        processor = Some(worker);
                    }
                    Err(error) => {
                        tracing::warn!("camera blur preview unavailable: {error:#}");
                        blur_failed = true;
                        #[cfg(target_os = "linux")]
                        if let Some(recording) = &recording {
                            recording.publisher.fail(format!(
                                "Requested camera blur initialization failed: {error:#}"
                            ));
                        }
                    }
                }
            }
            if let Some(worker) = processor.as_mut() {
                #[cfg(target_os = "linux")]
                let require_verified_output = recording.is_some();
                #[cfg(not(target_os = "linux"))]
                let require_verified_output = false;
                let processed = if require_verified_output {
                    worker
                        .process_with_status(&image, dims, mode)
                        .map(|(image, status)| (image, Some(status)))
                } else {
                    worker
                        .process(&image, dims, mode)
                        .map(|image| (image, None))
                };
                match processed {
                    Ok((blurred, status)) => {
                        image = blurred;
                        #[cfg(not(target_os = "linux"))]
                        drop(status);
                        #[cfg(target_os = "linux")]
                        if let Some(recording) = &recording {
                            let applied = status
                                .as_ref()
                                .ok_or_else(|| {
                                    "Requested camera blur has no output receipt".to_string()
                                })
                                .and_then(|status| {
                                    checked_recording_blur(
                                        status,
                                        mode,
                                        (dims.0 as u32, dims.1 as u32),
                                        Instant::now(),
                                    )
                                });
                            match applied {
                                Ok(mask) => {
                                    effects_ready = mask.is_some();
                                    applied_mask = mask;
                                }
                                Err(error) => recording.publisher.fail(error),
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!("camera blur preview stopped: {error:#}");
                        processor = None;
                        blur_failed = true;
                        #[cfg(target_os = "linux")]
                        if let Some(recording) = &recording {
                            recording
                                .publisher
                                .fail(format!("Requested camera blur failed: {error:#}"));
                        }
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        if effects_ready && let Some(recording) = &recording {
            recording.publish(&image, dims, frame.timestamp, applied_mask);
        }
        if active.load(Ordering::Acquire) {
            match preview_tx.try_send(crate::camera_window::CameraPreviewFrame { image, dims }) {
                Ok(()) | Err(flume::TrySendError::Full(_)) => {}
                Err(flume::TrySendError::Disconnected(_)) => {
                    #[cfg(target_os = "linux")]
                    if recording.is_some() {
                        continue;
                    }
                    break;
                }
            }
        }
    }
}

pub struct Feeds {
    camera_actor: Option<ActorRef<CameraFeed>>,
    camera_preview_sender: Option<flume::Sender<PreviewCameraFrame>>,
    camera_input_gate: Arc<tokio::sync::Mutex<()>>,
    mic_input_gate: Arc<tokio::sync::Mutex<()>>,
    mic_input_epoch: Arc<AtomicU64>,
    mic_actor: Option<ActorRef<MicrophoneFeed>>,
    camera_settings: Option<camera::CameraDeviceSettings>,
    microphone_settings: Option<microphone::MicrophoneDeviceSettings>,
    applied_settings: crate::store::RecordingDeviceSettings,
    camera_input_pending: bool,
    mic_input_pending: bool,
    mic_input_released: bool,
    microphone_error: Option<String>,
    camera_ready: Option<InputReady>,
    microphone_ready: Option<InputReady>,
    /// Selected camera; `Some` while the preview window should exist.
    pub camera: Option<SelectedCamera>,
    /// Selected microphone name.
    pub microphone: Option<String>,
    /// Rolling 200ms max of the mic level, in dB FS. `-96` when silent/absent.
    pub mic_level_db: f64,
    pub camera_error: Option<String>,
    camera_preview_parked: bool,
    /// Bumped on every camera/mic selection change; async completions from a
    /// previous selection see a stale epoch and drop their result.
    camera_epoch: u64,
    mic_epoch: u64,
    #[cfg(not(target_os = "macos"))]
    camera_preview_mirrored: Arc<AtomicBool>,
    #[cfg(not(target_os = "macos"))]
    camera_preview_active: Arc<AtomicBool>,
    #[cfg(not(target_os = "macos"))]
    camera_preview_blur: Arc<AtomicU8>,
    #[cfg(not(target_os = "macos"))]
    camera_preview_reset: Option<flume::Sender<CameraWorkerCommand>>,
    camera_input_epoch: Arc<AtomicU64>,
    #[cfg(target_os = "linux")]
    camera_recording_active: Arc<AtomicBool>,
    #[cfg(target_os = "linux")]
    camera_recording_generation: Arc<std::sync::atomic::AtomicU64>,
    // Channel-holding tasks; dropping them ends the pumps.
    _frame_pump: Option<gpui::Task<()>>,
    _meter_pump: Option<gpui::Task<()>>,
    // The mic error channel must outlive the stream (see recording.rs).
    _mic_errors: Option<flume::Receiver<cpal::StreamError>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectedCamera {
    pub id: DeviceOrModelID,
    pub label: String,
    pub device_id: String,
    pub model_id: Option<cap_camera::ModelID>,
}

struct FeedsGlobal(Entity<Feeds>);
impl Global for FeedsGlobal {}

impl Feeds {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let feeds = cx.new(|_| Self {
            camera_actor: None,
            camera_preview_sender: None,
            camera_input_gate: Arc::new(tokio::sync::Mutex::new(())),
            mic_input_gate: Arc::new(tokio::sync::Mutex::new(())),
            mic_input_epoch: Arc::new(AtomicU64::new(0)),
            mic_actor: None,
            camera_settings: None,
            microphone_settings: None,
            applied_settings: crate::store::RecordingDeviceSettings::default(),
            camera_input_pending: false,
            mic_input_pending: false,
            mic_input_released: false,
            microphone_error: None,
            camera_ready: None,
            microphone_ready: None,
            camera: None,
            microphone: None,
            mic_level_db: -96.0,
            camera_error: None,
            camera_preview_parked: false,
            camera_epoch: 0,
            mic_epoch: 0,
            #[cfg(not(target_os = "macos"))]
            camera_preview_mirrored: Arc::new(AtomicBool::new(false)),
            #[cfg(not(target_os = "macos"))]
            camera_preview_active: Arc::new(AtomicBool::new(true)),
            #[cfg(not(target_os = "macos"))]
            camera_preview_blur: Arc::new(AtomicU8::new(0)),
            #[cfg(not(target_os = "macos"))]
            camera_preview_reset: None,
            camera_input_epoch: Arc::new(AtomicU64::new(0)),
            #[cfg(target_os = "linux")]
            camera_recording_active: Arc::new(AtomicBool::new(false)),
            #[cfg(target_os = "linux")]
            camera_recording_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            _frame_pump: None,
            _meter_pump: None,
            _mic_errors: None,
        });
        cx.set_global(FeedsGlobal(feeds.clone()));
        feeds
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<FeedsGlobal>().0.clone()
    }

    /// The live actors, for a recording to lock. `None` when nothing is
    /// selected (or the actor died -- `recording::start` falls back to a
    /// per-recording feed in that case).
    pub fn camera_actor(&self) -> Option<ActorRef<CameraFeed>> {
        if self.camera_preview_parked {
            return None;
        }
        self.camera.as_ref()?;
        self.camera_actor.clone().filter(|actor| actor.is_alive())
    }

    #[cfg(target_os = "linux")]
    pub fn camera_processing_factory(&self) -> Option<CameraProcessingFactory> {
        Some(CameraProcessingFactory {
            commands: self.camera_preview_reset.clone()?,
            actor: self.camera_actor()?,
            selected: self.camera.as_ref()?.id.clone(),
            epoch: self.camera_epoch,
            current_epoch: self.camera_input_epoch.clone(),
            recording_active: self.camera_recording_active.clone(),
            next_generation: self.camera_recording_generation.clone(),
        })
    }

    pub fn mic_actor(&self) -> Option<ActorRef<MicrophoneFeed>> {
        self.microphone.as_ref()?;
        self.mic_actor.clone().filter(|actor| actor.is_alive())
    }

    pub fn input_readiness(&self) -> InputReadiness {
        InputReadiness {
            camera: self
                .camera_ready
                .clone()
                .filter(|_| self.camera_actor().is_some()),
            microphone: self
                .microphone_ready
                .clone()
                .filter(|_| self.mic_actor().is_some()),
        }
    }

    pub fn applied_device_settings(&self) -> crate::store::RecordingDeviceSettings {
        self.applied_settings
    }

    pub fn requested_device_settings(&self) -> crate::store::RecordingDeviceSettings {
        crate::store::RecordingDeviceSettings {
            camera: self.camera_settings,
            microphone: self.microphone_settings,
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn set_camera_preview_rendering(&self, enabled: bool) -> bool {
        self.camera_preview_active.swap(enabled, Ordering::AcqRel)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn set_camera_preview_state(&self, mirrored: bool, blur: crate::store::BlurMode) {
        self.camera_preview_mirrored
            .store(mirrored, Ordering::Relaxed);
        self.camera_preview_blur.store(
            match blur {
                crate::store::BlurMode::Off => 0,
                crate::store::BlurMode::Light => 1,
                crate::store::BlurMode::Heavy => 2,
            },
            Ordering::Relaxed,
        );
    }

    /// Select (or deselect) the camera. Opens/closes the preview window and
    /// points the app-scoped feed at the device.
    pub fn set_camera(&mut self, selection: Option<SelectedCamera>, cx: &mut Context<Self>) {
        let settings = selection.as_ref().and_then(|selection| {
            crate::store::RecordingDeviceSettings::for_camera(
                &selection.device_id,
                selection.model_id.as_ref(),
            )
        });
        self.set_camera_with_settings(selection, settings, cx);
    }

    pub fn set_camera_with_settings(
        &mut self,
        selection: Option<SelectedCamera>,
        settings: Option<camera::CameraDeviceSettings>,
        cx: &mut Context<Self>,
    ) -> u64 {
        if self.camera == selection
            && self.camera_settings == settings
            && self.camera_error.is_none()
        {
            return self.camera_epoch;
        }
        self.camera_epoch += 1;
        self.camera_input_epoch
            .store(self.camera_epoch, Ordering::Release);
        self.camera = selection.clone();
        self.camera_ready = None;
        self.camera_settings = settings;
        self.applied_settings.camera = None;
        self.camera_input_pending = false;
        self.camera_error = None;
        cx.notify();

        match selection {
            Some(selection) if !self.camera_preview_parked => {
                self.start_camera_preview(selection, cx);
            }
            Some(_) => self.remove_camera_input(cx),
            None => {
                self.remove_camera_input(cx);
                cx.defer(app_windows::close_camera_window);
            }
        }
        self.camera_epoch
    }

    pub fn camera_configuration_result(&self, epoch: u64) -> Option<Result<(), String>> {
        configuration_result(
            self.camera_epoch,
            epoch,
            self.camera_input_pending,
            self.camera_error.as_deref(),
        )
    }

    pub fn microphone_configuration_result(&self, epoch: u64) -> Option<Result<(), String>> {
        configuration_result(
            self.mic_epoch,
            epoch,
            self.mic_input_pending,
            self.microphone_error.as_deref(),
        )
    }

    pub fn park_camera_preview(&mut self, cx: &mut Context<Self>) {
        if self.camera_preview_parked {
            return;
        }

        self.camera_preview_parked = true;
        self.applied_settings.camera = None;
        self.camera_input_pending = false;
        self.camera_epoch += 1;
        self.camera_input_epoch
            .store(self.camera_epoch, Ordering::Release);

        #[cfg(not(target_os = "macos"))]
        {
            self.camera_preview_active.store(false, Ordering::Release);
            if let Some(reset) = &self.camera_preview_reset {
                let _ = reset.try_send(CameraWorkerCommand::Reset);
            }
        }

        self.remove_camera_input(cx);

        tracing::info!("camera preview parked");
    }

    pub fn resume_camera_preview(&mut self, cx: &mut Context<Self>) {
        if !self.camera_preview_parked {
            return;
        }

        self.camera_preview_parked = false;
        #[cfg(not(target_os = "macos"))]
        self.camera_preview_active.store(true, Ordering::Release);
        if let Some(selection) = self.camera.clone() {
            self.camera_epoch += 1;
            self.camera_input_epoch
                .store(self.camera_epoch, Ordering::Release);
            self.start_camera_preview(selection, cx);
            tracing::info!("camera preview resumed");
        }
    }

    fn start_camera_preview(&mut self, selection: SelectedCamera, cx: &mut Context<Self>) {
        self.camera_error = None;
        self.camera_input_pending = true;
        self.applied_settings.camera = None;
        let epoch = self.camera_epoch;
        let settings = self.camera_settings;
        let actor = self.ensure_camera_actor(cx);
        let sender = self.camera_preview_sender.clone();
        let gate = self.camera_input_gate.clone();
        let current_epoch = self.camera_input_epoch.clone();
        let readiness_epoch = current_epoch.clone();
        let set = gpui_tokio::Tokio::spawn(cx, async move {
            let ready = camera_input_operation(&gate, &current_epoch, epoch, async {
                let sender = sender
                    .as_ref()
                    .ok_or_else(|| "Camera preview subscription is unavailable".to_string())?;
                attach_camera_preview_sender(&actor, sender).await?;
                actor
                    .ask(camera::SetInput {
                        id: selection.id,
                        settings,
                    })
                    .await
                    .map_err(|error| error.to_string())
            })
            .await?;
            let camera = if let Some(ready) = ready {
                let (_, info) = ready.await.map_err(|error| error.to_string())?;
                Some(camera::CameraDeviceSettings {
                    width: Some(info.width),
                    height: Some(info.height),
                    frame_rate: Some(info.frame_rate.0 as f32 / info.frame_rate.1 as f32),
                })
            } else {
                None
            };
            Ok::<_, String>(crate::store::RecordingDeviceSettings {
                camera,
                microphone: None,
            })
        });
        let ready = owned_input_readiness(
            async move { set.await.unwrap_or_else(|error| Err(error.to_string())) },
            readiness_epoch,
            epoch,
        );
        self.camera_ready = Some(ready.clone());
        cx.spawn(async move |this, cx| {
            let result = ready.await;
            this.update(cx, |this, cx| {
                if this.camera_epoch != epoch {
                    return;
                }
                this.camera_input_pending = false;
                match result {
                    Ok(settings) => this.applied_settings.camera = settings.camera,
                    Err(error) => {
                        tracing::error!("camera input failed: {error}");
                        this.camera_error = Some(error);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.defer(app_windows::open_camera_window);
    }

    fn remove_camera_input(&self, cx: &Context<Self>) {
        let Some(actor) = self.camera_actor.clone() else {
            return;
        };
        let gate = self.camera_input_gate.clone();
        let current_epoch = self.camera_input_epoch.clone();
        let epoch = self.camera_epoch;
        gpui_tokio::Tokio::spawn(cx, async move {
            if let Err(error) = camera_input_operation(&gate, &current_epoch, epoch, async {
                actor
                    .ask(camera::RemoveInput)
                    .await
                    .map_err(|error| error.to_string())
            })
            .await
            {
                tracing::warn!("releasing the camera preview input: {error}");
            }
        })
        .detach();
    }

    /// Select (or deselect) the microphone. The feed keeps running between
    /// recordings so the pickers and bar have a live level.
    pub fn set_microphone(&mut self, label: Option<String>, cx: &mut Context<Self>) {
        let settings = label
            .as_deref()
            .and_then(crate::store::RecordingDeviceSettings::for_microphone);
        self.set_microphone_with_settings(label, settings, cx);
    }

    pub fn set_microphone_with_settings(
        &mut self,
        label: Option<String>,
        settings: Option<microphone::MicrophoneDeviceSettings>,
        cx: &mut Context<Self>,
    ) -> u64 {
        if self.microphone == label
            && self.microphone_settings == settings
            && !self.mic_input_released
            && self.microphone_error.is_none()
        {
            return self.mic_epoch;
        }
        self.mic_epoch += 1;
        self.mic_input_epoch
            .store(self.mic_epoch, Ordering::Release);
        self.microphone = label.clone();
        self.microphone_settings = settings;
        self.applied_settings.microphone = None;
        self.microphone_error = None;
        self.mic_input_pending = label.is_some();
        self.mic_input_released = false;
        self.mic_level_db = -96.0;
        let epoch = self.mic_epoch;
        let actor = self.ensure_mic_actor(cx);
        let gate = self.mic_input_gate.clone();
        let current_epoch = self.mic_input_epoch.clone();
        let readiness_epoch = current_epoch.clone();
        let task = gpui_tokio::Tokio::spawn(cx, async move {
            let ready = camera_input_operation(&gate, &current_epoch, epoch, async {
                if let Some(label) = label {
                    actor
                        .ask(microphone::SetInput { label, settings })
                        .await
                        .map(Some)
                        .map_err(|error| error.to_string())
                } else {
                    actor
                        .ask(microphone::RemoveInput)
                        .await
                        .map(|()| None)
                        .map_err(|error| error.to_string())
                }
            })
            .await?;
            let microphone = if let Some(Some(ready)) = ready {
                let config = ready.await.map_err(|error| error.to_string())?;
                Some(microphone::MicrophoneDeviceSettings {
                    sample_rate: Some(config.sample_rate().0),
                    channels: Some(config.channels()),
                })
            } else {
                None
            };
            Ok::<_, String>(crate::store::RecordingDeviceSettings {
                camera: None,
                microphone,
            })
        });
        let ready = owned_input_readiness(
            async move { task.await.unwrap_or_else(|error| Err(error.to_string())) },
            readiness_epoch,
            epoch,
        );
        self.microphone_ready = Some(ready.clone());
        cx.spawn(async move |this, cx| {
            let result = ready.await;
            this.update(cx, |this, cx| {
                if this.mic_epoch != epoch {
                    return;
                }
                this.mic_input_pending = false;
                match result {
                    Ok(settings) => this.applied_settings.microphone = settings.microphone,
                    Err(error) => {
                        tracing::warn!("microphone input failed: {error}");
                        this.microphone_error = Some(error);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
        epoch
    }

    /// Drop the live camera and microphone inputs without forgetting what was
    /// selected.
    ///
    /// `CapWindowId::Main`'s `CloseRequested` arm (`lib.rs:5666-5697`): when
    /// nothing is recording, hiding the main window pauses the camera preview
    /// and `ask`s both feeds for `RemoveInput`. It does *not* clear the
    /// frontend's `rawOptions` -- the pickers still show the device that was
    /// chosen -- so neither does this: only the hardware is released.
    pub fn release_inputs(&mut self, cx: &mut Context<Self>) {
        self.park_camera_preview(cx);
        self.mic_epoch += 1;
        self.mic_input_epoch
            .store(self.mic_epoch, Ordering::Release);
        self.mic_input_pending = false;
        self.mic_input_released = true;
        self.applied_settings.microphone = None;
        self.microphone_ready = None;
        if let Some(actor) = self.mic_actor.clone() {
            let gate = self.mic_input_gate.clone();
            let current_epoch = self.mic_input_epoch.clone();
            let epoch = self.mic_epoch;
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = camera_input_operation(&gate, &current_epoch, epoch, async {
                    actor
                        .ask(microphone::RemoveInput)
                        .await
                        .map_err(|error| error.to_string())
                })
                .await
                {
                    tracing::warn!("releasing the microphone feed: {error}");
                }
            })
            .detach();
        }
        self.mic_level_db = -96.0;
        cx.notify();
    }

    fn ensure_camera_actor(&mut self, cx: &mut Context<Self>) -> ActorRef<CameraFeed> {
        let actor = self.camera_actor.clone().filter(|actor| actor.is_alive());
        if let Some(actor) = actor.as_ref()
            && self
                .camera_preview_sender
                .as_ref()
                .is_some_and(|sender| !sender.is_disconnected())
        {
            return actor.clone();
        }

        // kameo spawns onto the ambient tokio runtime; this method runs on
        // gpui's main thread, so enter the gpui_tokio runtime first or the
        // spawn panics (unwind across the objc frame aborts the process).
        let actor = actor.unwrap_or_else(|| {
            let _runtime = gpui_tokio::Tokio::handle(cx).enter();
            CameraFeed::spawn(CameraFeed::default())
        });

        // The preview channel: bounded(4) so a stalled UI drops frames instead
        // of ballooning; the pump drains on the main thread and hands each
        // frame straight to the camera window.
        #[cfg(target_os = "macos")]
        let pump = {
            let (frame_tx, frame_rx) = flume::bounded::<cap_recording::NativeCameraFrame>(4);
            self.camera_preview_sender = Some(frame_tx);

            cx.spawn(async move |_this, cx| {
                while let Ok(frame) = frame_rx.recv_async().await {
                    cx.update(|cx| app_windows::deliver_camera_frame(frame, cx));
                }
            })
        };

        #[cfg(not(target_os = "macos"))]
        let pump = {
            let (frame_tx, frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);
            self.camera_preview_sender = Some(frame_tx);
            let (preview_tx, preview_rx) = flume::bounded(2);
            let (reset_tx, reset_rx) = flume::bounded(4);
            self.camera_preview_reset = Some(reset_tx);
            let mirrored = self.camera_preview_mirrored.clone();
            let active = self.camera_preview_active.clone();
            let blur = self.camera_preview_blur.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("camera-preview".into())
                .spawn(move || {
                    run_camera_preview_worker(CameraPreviewWorkerConfig {
                        frames: frame_rx,
                        previews: preview_tx,
                        commands: reset_rx,
                        mirrored,
                        active,
                        blur,
                    });
                })
            {
                tracing::error!("starting camera preview worker: {error}");
            }

            cx.spawn(async move |_this, cx| {
                while let Ok(frame) = preview_rx.recv_async().await {
                    cx.update(|cx| app_windows::deliver_camera_frame(frame, cx));
                }
            })
        };

        self._frame_pump = Some(pump);
        self.camera_actor = Some(actor.clone());
        actor
    }

    fn ensure_mic_actor(&mut self, cx: &mut Context<Self>) -> ActorRef<MicrophoneFeed> {
        if let Some(actor) = self.mic_actor.clone()
            && actor.is_alive()
        {
            return actor;
        }

        let (error_tx, error_rx) = flume::unbounded();
        self._mic_errors = Some(error_rx);
        // Same runtime-entry requirement as the camera actor above.
        let actor = {
            let _runtime = gpui_tokio::Tokio::handle(cx).enter();
            MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx))
        };

        // Meter channel, attached once for the actor's lifetime -- the same
        // shape as the Tauri `mic_meter_sender`.
        let (meter_tx, meter_rx) = flume::bounded::<MicrophoneSamples>(16);
        {
            let actor = actor.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(microphone::AddSender(meter_tx)).await {
                    tracing::error!("attaching mic meter sender: {error}");
                }
            })
            .detach();
        }

        let pump = cx.spawn(async move |this, cx| {
            // Port of `audio_meter.rs`: a 200ms max-hold window, coalesced to
            // ~20 updates/s so the meter does not repaint the window per audio
            // callback.
            let mut window_entries: Vec<(Instant, f64)> = Vec::new();
            let mut last_push = Instant::now() - Duration::from_secs(1);
            while let Ok(samples) = meter_rx.recv_async().await {
                let now = Instant::now();
                let db = db_fs(&samples);
                window_entries.push((now, db));
                window_entries
                    .retain(|(at, _)| now.duration_since(*at) <= Duration::from_millis(200));
                if now.duration_since(last_push) < Duration::from_millis(50) {
                    continue;
                }
                last_push = now;
                let max = window_entries
                    .iter()
                    .map(|(_, db)| *db)
                    .fold(f64::MIN, f64::max);
                // Quantized to 0.5dB -- under a pixel on both level mappings --
                // so an unchanged level (a silent or absent signal pins at
                // -96.0) stops waking every `Feeds` observer and the controls
                // bar at 20Hz for a bar that would not visibly move.
                let quantized = (max * 2.0).round() / 2.0;
                let changed = this.update(cx, |this: &mut Feeds, cx| {
                    if this.mic_level_db == quantized {
                        return false;
                    }
                    this.mic_level_db = quantized;
                    cx.notify();
                    true
                });
                match changed {
                    Err(_) => return,
                    Ok(true) => {
                        cx.update(app_windows::refresh_controls_window);
                    }
                    Ok(false) => {}
                }
            }
        });
        self._meter_pump = Some(pump);
        self.mic_actor = Some(actor.clone());
        actor
    }
}

#[cfg(any(not(target_os = "macos"), test))]
pub(crate) fn camera_preview_image(
    frame: &ffmpeg::frame::Video,
    scaler: &mut Option<ffmpeg::software::scaling::Context>,
    mirrored: bool,
    max_dims: Option<(u32, u32)>,
) -> Option<(Arc<gpui::RenderImage>, (usize, usize))> {
    let source_width = frame.width();
    let source_height = frame.height();
    let (width, height) = match max_dims {
        Some(max) => {
            crate::camera_blur_portable::fitted_dimensions(source_width, source_height, max)?
        }
        None if source_width > 0 && source_height > 0 => (source_width, source_height),
        None => return None,
    };

    let mut converted = ffmpeg::frame::Video::empty();
    let source = if frame.format() == ffmpeg::format::Pixel::BGRA
        && width == source_width
        && height == source_height
    {
        frame
    } else {
        let definition = scaler.as_ref().map(|context| context.input());
        let output = scaler.as_ref().map(|context| context.output());
        if definition.is_none_or(|input| {
            input.format != frame.format()
                || input.width != source_width
                || input.height != source_height
        }) || output.is_none_or(|output| output.width != width || output.height != height)
        {
            *scaler = Some(
                ffmpeg::software::scaling::Context::get(
                    frame.format(),
                    source_width,
                    source_height,
                    ffmpeg::format::Pixel::BGRA,
                    width,
                    height,
                    ffmpeg::software::scaling::Flags::BILINEAR,
                )
                .ok()?,
            );
        }
        scaler.as_mut()?.run(frame, &mut converted).ok()?;
        &converted
    };

    let width = width as usize;
    let height = height as usize;
    let row_bytes = width.checked_mul(4)?;
    let stride = source.stride(0);
    if stride < row_bytes {
        return None;
    }
    let input = source.data(0);
    if input.len() < height.checked_mul(stride)? {
        return None;
    }
    let mut pixels = vec![0; height.checked_mul(row_bytes)?];
    for (row, output) in pixels.chunks_exact_mut(row_bytes).enumerate() {
        let input = &input[row * stride..row * stride + row_bytes];
        if mirrored {
            for (destination, source) in output.chunks_exact_mut(4).zip(input.chunks_exact(4).rev())
            {
                destination.copy_from_slice(source);
            }
        } else {
            output.copy_from_slice(input);
        }
    }
    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    let image = Arc::new(gpui::RenderImage::new(smallvec::smallvec![
        image::Frame::new(image)
    ]));
    Some((image, (width, height)))
}

/// `db_fs` from `src-tauri/src/audio_meter.rs`: peak of the batch as dB FS,
/// clamped to [-96, 0].
fn db_fs(samples: &MicrophoneSamples) -> f64 {
    use cpal::SampleFormat;

    let sample_size = samples.format.sample_size();
    if sample_size == 0 || samples.data.len() < sample_size {
        return -96.0;
    }
    let peak = samples
        .data
        .chunks_exact(sample_size)
        .map(|data| {
            let value: f64 = match samples.format {
                SampleFormat::I8 => i8::from_ne_bytes([data[0]]) as f64 / i8::MAX as f64,
                SampleFormat::U8 => u8::from_ne_bytes([data[0]]) as f64 / u8::MAX as f64 - 0.5,
                SampleFormat::I16 => {
                    i16::from_ne_bytes([data[0], data[1]]) as f64 / i16::MAX as f64
                }
                SampleFormat::U16 => {
                    u16::from_ne_bytes([data[0], data[1]]) as f64 / u16::MAX as f64 - 0.5
                }
                SampleFormat::I32 => {
                    i32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                        / i32::MAX as f64
                }
                SampleFormat::U32 => {
                    u32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                        / u32::MAX as f64
                        - 0.5
                }
                SampleFormat::F32 => {
                    f32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                }
                SampleFormat::F64 => f64::from_ne_bytes([
                    data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
                ]),
                _ => 0.0,
            };
            value.abs()
        })
        .fold(0.0f64, f64::max);

    (20.0 * peak.log10()).clamp(-96.0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn same_device_format_change_discards_queued_previous_configuration() {
        let gate = tokio::sync::Mutex::new(());
        let current = AtomicU64::new(1);
        let guard = gate.lock().await;
        let first = camera_input_operation(&gate, &current, 1, async {
            Ok((
                "same-device",
                camera::CameraDeviceSettings {
                    width: Some(1280),
                    height: Some(720),
                    frame_rate: Some(30.),
                },
            ))
        });
        tokio::pin!(first);
        assert!(futures_util::poll!(&mut first).is_pending());
        current.store(2, Ordering::Release);
        let second = camera_input_operation(&gate, &current, 2, async {
            Ok((
                "same-device",
                camera::CameraDeviceSettings {
                    width: Some(1920),
                    height: Some(1080),
                    frame_rate: Some(60.),
                },
            ))
        });
        tokio::pin!(second);
        assert!(futures_util::poll!(&mut second).is_pending());
        drop(guard);
        assert_eq!(first.await.unwrap(), None);
        let (device, settings) = second.await.unwrap().unwrap();
        assert_eq!(device, "same-device");
        assert_eq!(settings.width, Some(1920));
        assert_eq!(settings.frame_rate, Some(60.));
        assert!(configuration_result(2, 1, false, None).unwrap().is_err());
    }

    #[tokio::test]
    async fn input_readiness_rejects_late_ack_for_preview_and_recording_waiters() {
        let current = Arc::new(AtomicU64::new(7));
        let (send, receive) = tokio::sync::oneshot::channel();
        let ready = owned_input_readiness(
            async move { receive.await.map_err(|error| error.to_string()) },
            current.clone(),
            7,
        );
        let mut recording_waiter = ready.clone();
        assert!(futures_util::poll!(&mut recording_waiter).is_pending());
        current.store(8, Ordering::Release);
        send.send(crate::store::RecordingDeviceSettings::default())
            .unwrap();
        assert!(ready.await.unwrap_err().contains("selection changed"));
        assert!(recording_waiter.await.is_err());
        let applied = crate::store::RecordingDeviceSettings {
            camera: Some(camera::CameraDeviceSettings {
                width: Some(1280),
                height: Some(720),
                frame_rate: Some(29.97),
            }),
            microphone: None,
        };
        let ready = owned_input_readiness(async move { Ok(applied) }, current, 8);
        assert_eq!(ready.clone().await.unwrap(), applied);
        assert_eq!(ready.await.unwrap(), applied);
    }

    #[test]
    fn input_configuration_status_never_reports_pending_or_failed_as_ready() {
        assert_eq!(configuration_result(3, 3, true, None), None);
        assert_eq!(
            configuration_result(3, 3, false, Some("unavailable")),
            Some(Err("unavailable".into()))
        );
        assert_eq!(configuration_result(3, 3, false, None), Some(Ok(())));
        assert!(configuration_result(4, 3, false, None).unwrap().is_err());
    }

    #[tokio::test]
    async fn camera_preview_subscription_survives_removal_and_reattaches_once() {
        let actor = CameraFeed::spawn(CameraFeed::default());
        let (sender, receiver) = flume::bounded(1);
        attach_camera_preview_sender(&actor, &sender).await.unwrap();
        assert_eq!(receiver.sender_count(), 2);

        actor.ask(camera::RemoveInput).await.unwrap();
        assert_eq!(receiver.sender_count(), 1);
        assert!(!receiver.is_disconnected());

        attach_camera_preview_sender(&actor, &sender).await.unwrap();
        attach_camera_preview_sender(&actor, &sender).await.unwrap();
        assert_eq!(receiver.sender_count(), 2);
        drop(sender);
        assert!(!receiver.is_disconnected());
        actor.ask(camera::RemoveInput).await.unwrap();
        assert!(receiver.is_disconnected());
        actor.stop_gracefully().await.unwrap();
        actor.wait_for_shutdown().await;
    }

    #[tokio::test]
    async fn camera_preview_reconnect_waits_for_started_removal() {
        let actor = CameraFeed::spawn(CameraFeed::default());
        let (sender, receiver) = flume::bounded(1);
        attach_camera_preview_sender(&actor, &sender).await.unwrap();
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let epoch = Arc::new(AtomicU64::new(1));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let removal = tokio::spawn({
            let actor = actor.clone();
            let gate = gate.clone();
            let epoch = epoch.clone();
            async move {
                camera_input_operation(&gate, &epoch, 1, async {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    actor
                        .ask(camera::RemoveInput)
                        .await
                        .map_err(|error| error.to_string())
                })
                .await
            }
        });
        started_rx.await.unwrap();
        epoch.store(2, Ordering::Release);
        let reconnect = camera_input_operation(
            &gate,
            &epoch,
            2,
            attach_camera_preview_sender(&actor, &sender),
        );
        tokio::pin!(reconnect);
        assert!(futures_util::poll!(&mut reconnect).is_pending());
        release_tx.send(()).unwrap();
        assert_eq!(removal.await.unwrap().unwrap(), Some(()));
        assert_eq!(reconnect.await.unwrap(), Some(()));
        assert_eq!(receiver.sender_count(), 2);
        actor.stop_gracefully().await.unwrap();
        actor.wait_for_shutdown().await;
    }

    #[tokio::test]
    async fn camera_preview_stale_removal_cannot_erase_new_subscription() {
        let actor = CameraFeed::spawn(CameraFeed::default());
        let (sender, receiver) = flume::bounded(1);
        let gate = tokio::sync::Mutex::new(());
        let epoch = AtomicU64::new(2);
        let stale_removal = camera_input_operation(&gate, &epoch, 1, async {
            actor
                .ask(camera::RemoveInput)
                .await
                .map_err(|error| error.to_string())
        });
        assert_eq!(
            camera_input_operation(
                &gate,
                &epoch,
                2,
                attach_camera_preview_sender(&actor, &sender),
            )
            .await
            .unwrap(),
            Some(())
        );
        assert_eq!(stale_removal.await.unwrap(), None);
        drop(sender);
        assert!(!receiver.is_disconnected());
        actor.stop_gracefully().await.unwrap();
        actor.wait_for_shutdown().await;
    }

    #[tokio::test]
    async fn camera_preview_failed_attachment_releases_input_gate() {
        let actor = CameraFeed::spawn(CameraFeed::default());
        let (sender, receiver) = flume::bounded(1);
        drop(receiver);
        let gate = tokio::sync::Mutex::new(());
        let epoch = AtomicU64::new(1);
        let error = camera_input_operation(
            &gate,
            &epoch,
            1,
            attach_camera_preview_sender(&actor, &sender),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Camera preview worker is unavailable");
        let (sender, receiver) = flume::bounded(1);
        assert_eq!(
            camera_input_operation(
                &gate,
                &epoch,
                1,
                attach_camera_preview_sender(&actor, &sender),
            )
            .await
            .unwrap(),
            Some(())
        );
        assert_eq!(receiver.sender_count(), 2);
        actor.stop_gracefully().await.unwrap();
        actor.wait_for_shutdown().await;
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recording_blur_pending_failure_stale_and_wrong_effect_cannot_certify_pixels() {
        use cap_camera_effects::{
            BlurFailure, BlurMaskReceipt, BlurMaskStatus, BlurMode, BlurOutputStatus,
        };
        let now = Instant::now();
        let mut status = BlurOutputStatus {
            mode: BlurMode::Light,
            output_sequence: 1,
            output_dimensions: (4, 2),
            mask: BlurMaskStatus::Pending,
        };
        assert!(
            checked_recording_blur(&status, BlurMode::Light, (4, 2), now)
                .unwrap()
                .is_none()
        );
        for failure in [
            BlurFailure::Inference("failed".into()),
            BlurFailure::Readback("failed".into()),
        ] {
            status.mask = BlurMaskStatus::Failed(failure);
            assert!(checked_recording_blur(&status, BlurMode::Light, (4, 2), now).is_err());
        }
        status.mask = BlurMaskStatus::Ready(BlurMaskReceipt {
            generation: 7,
            input_submitted_at: now,
            inference_completed_at: now,
            input_dimensions: (4, 2),
        });
        let applied = checked_recording_blur(&status, BlurMode::Light, (4, 2), now)
            .unwrap()
            .unwrap();
        assert_eq!(applied.generation, 7);
        assert_eq!(applied.submitted_at, now);
        assert!(checked_recording_blur(&status, BlurMode::Heavy, (4, 2), now).is_err());
        assert!(checked_recording_blur(&status, BlurMode::Light, (2, 4), now).is_err());
        assert!(
            checked_recording_blur(
                &status,
                BlurMode::Light,
                (4, 2),
                now + cap_recording::instant_recording::LINUX_CAMERA_MAX_MASK_AGE
                    + Duration::from_millis(1)
            )
            .is_err()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recording_camera_reservation_releases_only_its_owned_attempt() {
        let active = Arc::new(AtomicBool::new(false));
        let first = CameraRecordingReservation::try_acquire(&active).unwrap();
        assert!(active.load(Ordering::Acquire));
        assert!(CameraRecordingReservation::try_acquire(&active).is_none());
        assert!(active.load(Ordering::Acquire));
        drop(first);
        assert!(!active.load(Ordering::Acquire));
        let restarted = CameraRecordingReservation::try_acquire(&active).unwrap();
        assert!(CameraRecordingReservation::try_acquire(&active).is_none());
        drop(restarted);
        assert!(!active.load(Ordering::Acquire));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recording_camera_rejects_queued_frames_and_changed_selection() {
        let old = Instant::now();
        let subscribed = old + Duration::from_millis(1);
        assert_eq!(
            validate_recording_camera_frame(
                cap_timestamp::Timestamp::Instant(old),
                subscribed,
                7,
                7
            ),
            Ok(false)
        );
        assert_eq!(
            validate_recording_camera_frame(
                cap_timestamp::Timestamp::Instant(subscribed),
                subscribed,
                7,
                7
            ),
            Ok(true)
        );
        assert!(
            validate_recording_camera_frame(
                cap_timestamp::Timestamp::Instant(subscribed),
                subscribed,
                7,
                8
            )
            .is_err()
        );
        assert!(
            validate_recording_camera_frame(
                cap_timestamp::Timestamp::Instant(old),
                subscribed,
                7,
                8
            )
            .is_err()
        );
        assert!(
            validate_recording_camera_frame(
                cap_timestamp::Timestamp::SystemTime(std::time::SystemTime::now()),
                subscribed,
                7,
                7,
            )
            .is_err()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recording_processing_keeps_exact_mirror_and_light_heavy_identity() {
        use cap_recording::instant_recording::{LinuxCameraBlur, LinuxCameraProcessing};
        for (blur, encoded) in [
            (LinuxCameraBlur::Off, 0),
            (LinuxCameraBlur::Light, 1),
            (LinuxCameraBlur::Heavy, 2),
        ] {
            for mirrored in [false, true] {
                assert_eq!(
                    frozen_processing_state(LinuxCameraProcessing { mirrored, blur }),
                    (encoded, mirrored)
                );
            }
        }
    }

    /// Both level mappings keep the web app's orientation: `picker_level` is 1
    /// at silence (it is the overlay's *right* offset), `bar_level` is 0 at
    /// silence (it is the track's fill fraction).
    #[test]
    fn level_mappings_match_the_web_formulas() {
        assert_eq!(picker_level(-96.0), 1.0);
        assert_eq!(picker_level(0.0), 0.0);
        assert!((picker_level(-20.0) - 0.5f64.sqrt()).abs() < 1e-9);

        assert_eq!(bar_level(-96.0), 0.0);
        assert_eq!(bar_level(-60.0), 0.0);
        assert_eq!(bar_level(0.0), 1.0);
        assert!((bar_level(-30.0) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn camera_preview_preserves_bgra_pixels_and_mirrors_each_row() {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 2, 2);
        let stride = frame.stride(0);
        let pixels = frame.data_mut(0);
        pixels[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        pixels[stride..stride + 8].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);

        let mut scaler = None;
        let (image, dims) = camera_preview_image(&frame, &mut scaler, false, None).unwrap();
        assert_eq!(dims, (2, 2));
        assert_eq!(
            image.as_bytes(0).unwrap(),
            &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
        assert!(scaler.is_none());

        let (mirrored, dims) = camera_preview_image(&frame, &mut scaler, true, None).unwrap();
        assert_eq!(dims, (2, 2));
        assert_eq!(
            mirrored.as_bytes(0).unwrap(),
            &[5, 6, 7, 8, 1, 2, 3, 4, 13, 14, 15, 16, 9, 10, 11, 12]
        );
    }

    #[test]
    fn camera_preview_converts_rgba_to_bgra() {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 2, 1);
        frame.data_mut(0)[..8].copy_from_slice(&[10, 20, 30, 255, 40, 50, 60, 128]);

        let mut scaler = None;
        let (image, dims) = camera_preview_image(&frame, &mut scaler, false, None).unwrap();
        assert_eq!(dims, (2, 1));
        assert_eq!(
            image.as_bytes(0).unwrap(),
            &[30, 20, 10, 255, 60, 50, 40, 128]
        );
        assert!(scaler.is_some());
    }

    #[test]
    fn camera_preview_downscales_only_when_blur_requires_it() {
        let frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 64, 32);
        let mut scaler = None;

        let (_, full_size) = camera_preview_image(&frame, &mut scaler, false, None).unwrap();
        assert_eq!(full_size, (64, 32));
        assert!(scaler.is_none());

        let (_, capped) = camera_preview_image(&frame, &mut scaler, false, Some((32, 32))).unwrap();
        assert_eq!(capped, (32, 16));
        assert!(scaler.is_some());

        let (_, recapped) =
            camera_preview_image(&frame, &mut scaler, false, Some((16, 16))).unwrap();
        assert_eq!(recapped, (16, 8));
    }
}
