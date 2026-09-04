use cap_camera::CameraInfo;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use cap_camera_ffmpeg::*;
use cap_fail::fail_err;
use cap_media_info::VideoInfo;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use cap_timestamp::Timestamp;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use kameo::prelude::*;
use replace_with::replace_with_or_abort;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use std::cmp::Ordering;
use std::{
    ops::Deref,
    sync::{
        Arc, Weak,
        mpsc::{self, SyncSender},
    },
    time::Duration,
};
use tokio::{sync::oneshot, task::LocalSet};
use tracing::{debug, error, trace, warn};

use crate::ffmpeg::FFmpegVideoFrame;
use crate::output_pipeline::NativeCameraFrame;

const CAMERA_INIT_TIMEOUT: Duration = Duration::from_secs(4);
/// Outer deadline for camera readiness. Must cover both capture attempts on
/// macOS (native + compatibility fallback) plus session teardown in between.
const CAMERA_READY_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONCURRENT_CAMERA_SETUPS: usize = 2;

#[cfg(target_os = "macos")]
static CAMERA_CAPTURE_LIFECYCLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "macos")]
fn camera_capture_lifecycle_guard() -> std::sync::MutexGuard<'static, ()> {
    CAMERA_CAPTURE_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

#[derive(Actor)]
pub struct CameraFeed {
    setup_slots: Arc<tokio::sync::Semaphore>,
    setup_cancel: tokio_util::sync::CancellationToken,
    _cancel_setup: tokio_util::sync::DropGuard,
    lock_generation: u64,
    setup_generation: u64,
    state: State,
    senders: Vec<flume::Sender<FFmpegVideoFrame>>,
    ffmpeg_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    native_senders: Vec<flume::Sender<NativeCameraFrame>>,
    native_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    on_ready: Vec<oneshot::Sender<()>>,
    on_disconnect: Vec<Box<dyn Fn() + Send>>,
}

enum State {
    Open(OpenState),
    Locked {
        inner: AttachedState,
        token: Weak<()>,
    },
}

impl State {
    fn try_as_open(&mut self) -> Result<&mut OpenState, FeedLockedError> {
        let is_stale = matches!(self, Self::Locked { token, .. } if token.strong_count() == 0);

        if is_stale {
            warn!("Detected stale camera feed lock, auto-recovering");
            replace_with_or_abort(self, |state| {
                if let Self::Locked { inner, .. } = state {
                    Self::Open(OpenState {
                        connecting: None,
                        attached: Some(inner),
                    })
                } else {
                    state
                }
            });
        }

        if let Self::Open(open_state) = self {
            Ok(open_state)
        } else {
            Err(FeedLockedError)
        }
    }
}

struct OpenState {
    connecting: Option<ConnectingState>,
    attached: Option<AttachedState>,
}

impl OpenState {
    fn handle_input_connected(&mut self, data: InputConnected) -> bool {
        if let Some(connecting) = &self.connecting
            && data.id == connecting.id
            && data.generation == connecting.generation
        {
            trace!("Attaching new camera");

            let id = data.id.clone();

            if let Some(attached) = &mut self.attached {
                attached.stage_pending_release();
                attached.overwrite(id, data);
            } else {
                self.attached = Some(AttachedState::new(id, data));
            }

            self.connecting = None;
            true
        } else {
            false
        }
    }
}

struct ConnectingState {
    id: DeviceOrModelID,
    generation: u64,
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
    done_tx: SyncSender<()>,
}

struct AttachedState {
    #[allow(dead_code)]
    id: DeviceOrModelID,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    done_tx: mpsc::SyncSender<()>,
    pending_release: Option<mpsc::SyncSender<()>>,
}

impl AttachedState {
    fn new(id: DeviceOrModelID, data: InputConnected) -> Self {
        let InputConnected {
            done_tx,
            camera_info,
            video_info,
            ..
        } = data;

        Self {
            id,
            camera_info,
            video_info,
            done_tx,
            pending_release: None,
        }
    }

    fn overwrite(&mut self, id: DeviceOrModelID, data: InputConnected) {
        let InputConnected {
            done_tx,
            camera_info,
            video_info,
            ..
        } = data;

        self.id = id;
        self.camera_info = camera_info;
        self.video_info = video_info;
        self.done_tx = done_tx;
    }

    fn stage_pending_release(&mut self) {
        if let Some(pending) = self.pending_release.take() {
            let _ = pending.try_send(());
        }

        self.pending_release = Some(self.done_tx.clone());
    }

    fn finalize_pending_release(&mut self) {
        if let Some(pending) = self.pending_release.take() {
            let _ = pending.try_send(());
        }
    }
}

impl Default for CameraFeed {
    fn default() -> Self {
        let setup_cancel = tokio_util::sync::CancellationToken::new();
        Self {
            setup_slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CAMERA_SETUPS)),
            _cancel_setup: setup_cancel.clone().drop_guard(),
            setup_cancel,
            lock_generation: 0,
            setup_generation: 0,
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
            ffmpeg_sender_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            native_senders: Vec::new(),
            native_sender_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            on_ready: Vec::new(),
            on_disconnect: Vec::new(),
        }
    }
}

impl CameraFeed {
    fn next_setup_generation(&mut self) -> u64 {
        self.setup_generation = self.setup_generation.wrapping_add(1);
        self.setup_generation
    }
}

#[derive(Reply)]
pub struct CameraFeedLock {
    actor: ActorRef<CameraFeed>,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    drop_tx: Option<oneshot::Sender<()>>,
    _token: Arc<()>,
}

impl CameraFeedLock {
    pub fn camera_info(&self) -> &cap_camera::CameraInfo {
        &self.camera_info
    }

    pub fn video_info(&self) -> &VideoInfo {
        &self.video_info
    }
}

impl Deref for CameraFeedLock {
    type Target = ActorRef<CameraFeed>;

    fn deref(&self) -> &Self::Target {
        &self.actor
    }
}

impl Drop for CameraFeedLock {
    fn drop(&mut self) {
        if let Some(drop_tx) = self.drop_tx.take() {
            let _ = drop_tx.send(());
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub enum DeviceOrModelID {
    DeviceID(String),
    ModelID(cap_camera::ModelID),
}

impl DeviceOrModelID {
    pub fn from_info(info: &cap_camera::CameraInfo) -> Self {
        info.model_id()
            .map(|v| Self::ModelID(v.clone()))
            .unwrap_or_else(|| Self::DeviceID(info.device_id().to_string()))
    }
}

#[derive(
    serde::Serialize, serde::Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Default,
)]
#[serde(rename_all = "camelCase")]
pub struct CameraDeviceSettings {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f32>,
}

// Public Requests

pub struct SetInput {
    pub id: DeviceOrModelID,
    pub settings: Option<CameraDeviceSettings>,
}

pub struct RemoveInput;

pub struct AddSender(pub flume::Sender<FFmpegVideoFrame>);

pub struct AddNativeSender(pub flume::Sender<NativeCameraFrame>);

pub struct RemoveSender(pub flume::Sender<FFmpegVideoFrame>);

pub struct RemoveNativeSender(pub flume::Sender<NativeCameraFrame>);

pub struct ListenForReady(pub oneshot::Sender<()>);

pub struct OnFeedDisconnect(pub Box<dyn Fn() + Send>);

pub struct Lock;

// Private Events

#[derive(Clone)]
struct InputConnected {
    generation: u64,
    id: DeviceOrModelID,
    done_tx: SyncSender<()>,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
}

type ReadyFuture = Shared<BoxFuture<'static, Result<InputConnected, SetInputError>>>;

#[derive(Clone, Copy)]
enum CameraSetupFlow {
    Open,
    Locked { lock_generation: u64 },
}

struct InputConnectFailed {
    id: DeviceOrModelID,
    generation: u64,
}

struct LockedCameraInputReconnected {
    generation: u64,
    lock_generation: u64,
    id: DeviceOrModelID,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    done_tx: SyncSender<()>,
}

struct NewFrame(FFmpegVideoFrame);

struct NewNativeFrame(NativeCameraFrame);

struct Unlock {
    generation: u64,
}

struct FinalizePendingRelease {
    generation: u64,
    id: DeviceOrModelID,
}

struct CameraSetupArgs {
    setup_slots: Arc<tokio::sync::Semaphore>,
    setup_cancel: tokio_util::sync::CancellationToken,
    id: DeviceOrModelID,
    generation: u64,
    settings: Option<CameraDeviceSettings>,
    actor_ref: ActorRef<CameraFeed>,
    new_frame_recipient: Recipient<NewFrame>,
    native_frame_recipient: Recipient<NewNativeFrame>,
    ffmpeg_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    native_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    flow: CameraSetupFlow,
}

fn bounded_camera_ready(
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
    cancel: tokio_util::sync::CancellationToken,
    timeout: Duration,
) -> ReadyFuture {
    let deadline = tokio::time::Instant::now() + timeout;
    let cancel_on_drop = cancel.clone().drop_guard();
    async move {
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(SetInputError::SetupCancelled),
            result = tokio::time::timeout_at(deadline, ready) => {
                result.unwrap_or_else(|error| Err(SetInputError::Timeout(error.to_string())))
            }
        };
        if result.is_ok() {
            drop(cancel_on_drop.disarm());
        }
        result
    }
    .boxed()
    .shared()
}

async fn spawn_camera_worker(
    slots: Arc<tokio::sync::Semaphore>,
    cancel: tokio_util::sync::CancellationToken,
    worker: impl FnOnce(tokio::sync::OwnedSemaphorePermit) + Send + 'static,
) -> Result<(), SetInputError> {
    let permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(SetInputError::SetupCancelled),
        permit = slots.acquire_owned() => permit.map_err(|error| {
            SetInputError::StartCapturing(format!("Camera setup is unavailable: {error}"))
        })?,
    };
    if cancel.is_cancelled() {
        return Err(SetInputError::SetupCancelled);
    }
    std::thread::Builder::new()
        .name("camera-capture".into())
        .spawn(move || worker(permit))
        .map(drop)
        .map_err(|error| {
            SetInputError::StartCapturing(format!("Could not start camera worker: {error}"))
        })
}

fn spawn_camera_setup(args: CameraSetupArgs) -> (ReadyFuture, SyncSender<()>) {
    let CameraSetupArgs {
        setup_slots,
        setup_cancel,
        id,
        generation,
        settings,
        actor_ref,
        new_frame_recipient,
        native_frame_recipient,
        ffmpeg_sender_count,
        native_sender_count,
        flow,
    } = args;

    let (ready_tx, ready_rx) = oneshot::channel::<Result<InputConnected, SetInputError>>();
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);

    let ready = bounded_camera_ready(
        ready_rx
            .map(|v| {
                v.map_err(|_| SetInputError::BuildStreamCrashed)
                    .and_then(|v| v)
            })
            .boxed(),
        setup_cancel.clone(),
        CAMERA_READY_TIMEOUT,
    );

    if matches!(flow, CameraSetupFlow::Open) {
        let ready = ready.clone();
        let actor = actor_ref.clone();
        let id = id.clone();
        tokio::spawn(async move {
            if ready.await.is_err() {
                let _ = actor.tell(InputConnectFailed { id, generation }).await;
            }
        });
    }

    let done_rx_thread = done_rx;
    let done_tx_thread = done_tx.clone();
    let ready_tx_thread = ready_tx;

    tokio::spawn(async move {
        let worker = spawn_camera_worker(setup_slots, setup_cancel.clone(), move |setup_permit| {
            if setup_cancel.is_cancelled() {
                return;
            }
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx_thread.send(Err(SetInputError::StartCapturing(format!(
                        "Could not initialize the camera worker: {error}"
                    ))));
                    return;
                }
            };

            {
                #[cfg(target_os = "macos")]
                let _capture_lifecycle_guard = camera_capture_lifecycle_guard();

                LocalSet::new().block_on(&runtime, async move {
                if setup_cancel.is_cancelled() || done_rx_thread.try_recv().is_ok() {
                    return;
                }

                let setup_result = setup_camera(
                    &id,
                    settings,
                    new_frame_recipient,
                    native_frame_recipient,
                    ffmpeg_sender_count,
                    native_sender_count,
                    &done_rx_thread,
                )
                .await;

                let handle = match setup_result {
                    Ok(result) => {
                        let SetupCameraResult {
                            handle,
                            camera_info,
                            video_info,
                        } = result;

                        if setup_cancel.is_cancelled() {
                            let _ = handle.stop_capturing();
                            return;
                        }

                        let ready_payload = InputConnected {
                            generation,
                            id: id.clone(),
                            camera_info: camera_info.clone(),
                            video_info,
                            done_tx: done_tx_thread.clone(),
                        };

                        match flow {
                            CameraSetupFlow::Open => {
                                if ready_tx_thread.send(Ok(ready_payload.clone())).is_err() {
                                    let _ = handle.stop_capturing();
                                    return;
                                }
                                let _ = actor_ref.ask(ready_payload).await;
                            }
                            CameraSetupFlow::Locked { lock_generation } => {
                                let reconnect_result = actor_ref
                                    .ask(LockedCameraInputReconnected {
                                        generation,
                                        lock_generation,
                                        id: id.clone(),
                                        camera_info,
                                        video_info,
                                        done_tx: done_tx_thread.clone(),
                                    })
                                    .await;

                                match reconnect_result {
                                    Ok(true) => {
                                        let _ = ready_tx_thread.send(Ok(ready_payload));
                                        let _ = actor_ref
                                            .tell(FinalizePendingRelease {
                                                generation,
                                                id: id.clone(),
                                            })
                                            .await;
                                    }
                                    Ok(false) => {
                                        warn!(
                                            "Locked camera state changed before reconnecting {:?}",
                                            id
                                        );
                                        let _ = ready_tx_thread
                                            .send(Err(SetInputError::BuildStreamCrashed));
                                        let _ = handle.stop_capturing();
                                        return;
                                    }
                                    Err(err) => {
                                        error!(
                                            ?err,
                                            "Failed to update locked camera state for {:?}", id
                                        );
                                        let _ = ready_tx_thread
                                            .send(Err(SetInputError::BuildStreamCrashed));
                                        let _ = handle.stop_capturing();
                                        return;
                                    }
                                }
                            }
                        }

                        handle
                    }
                    Err(e) => {
                        let _ = ready_tx_thread.send(Err(e.clone()));

                        return;
                    }
                };

                if setup_cancel.is_cancelled() {
                    let _ = handle.stop_capturing();
                    return;
                }
                drop(setup_permit);

                debug!(
                    "Camera capture thread: waiting for done signal for {:?}",
                    &id
                );

                drop(done_tx_thread);
                match done_rx_thread.recv() {
                    Ok(()) => debug!("Camera capture thread: stop signal received for {:?}", &id),
                    Err(_) => debug!(
                        "Camera capture thread: stop signal channel closed for {:?}",
                        &id
                    ),
                }

                let _ = handle.stop_capturing();

                std::thread::sleep(Duration::from_millis(50));

                debug!("Camera capture thread: capture closed for {:?}", &id);
            });
            }

            drop(runtime);
        })
        .await;
        if let Err(error) = worker {
            debug!(%error, "Camera setup worker did not start");
        }
    });

    (ready, done_tx)
}

fn camera_ready_future(
    ready: ReadyFuture,
) -> BoxFuture<'static, Result<(CameraInfo, VideoInfo), SetInputError>> {
    ready
        .map(|result| result.map(|v| (v.camera_info, v.video_info)))
        .boxed()
}

// Impls

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("FeedLocked")]
pub struct FeedLockedError;

#[derive(Clone, Debug, thiserror::Error)]
pub enum SetInputError {
    #[error(transparent)]
    Locked(#[from] FeedLockedError),
    #[error("DeviceNotFound")]
    DeviceNotFound,
    #[error("BuildStreamCrashed")]
    BuildStreamCrashed, // TODO: Maybe rename this?
    #[error("Camera setup was cancelled by a newer selection")]
    SetupCancelled,
    #[error("InvalidFormat")]
    InvalidFormat,
    #[error("CameraTimeout")]
    Timeout(String),
    #[error("StartCapturing/{0}")]
    StartCapturing(String),
    #[error("Failed to initialize camera")]
    Initialisation,
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn find_camera(selected_camera: &DeviceOrModelID) -> Option<cap_camera::CameraInfo> {
    cap_camera::list_cameras().find(|c| match selected_camera {
        DeviceOrModelID::DeviceID(device_id) => c.device_id() == device_id,
        DeviceOrModelID::ModelID(model_id) => c.model_id() == Some(model_id),
    })
}

struct SetupCameraResult {
    handle: cap_camera::CaptureHandle,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
static CAMERA_CALLBACK_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const TARGET_CAMERA_WIDTH: u32 = 1280;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const TARGET_CAMERA_HEIGHT: u32 = 720;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const TARGET_CAMERA_FRAME_RATE: f32 = 30.0;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const PREFERRED_CAMERA_FRAME_RATE: f32 = 29.0;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const MIN_CAMERA_FRAME_RATE: f32 = 24.0;

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn select_preferred_camera_format(
    formats: &[cap_camera::Format],
    settings: CameraDeviceSettings,
) -> Option<cap_camera::Format> {
    let mut matches = formats
        .iter()
        .filter(|format| {
            settings.width.is_none_or(|width| format.width() == width)
                && settings
                    .height
                    .is_none_or(|height| format.height() == height)
                && settings
                    .frame_rate
                    .is_none_or(|frame_rate| (format.frame_rate() - frame_rate).abs() < 0.5)
        })
        .cloned()
        .collect::<Vec<_>>();

    if matches.is_empty() && settings.width.is_some() && settings.height.is_some() {
        matches = formats
            .iter()
            .filter(|format| {
                settings.width.is_none_or(|width| format.width() == width)
                    && settings
                        .height
                        .is_none_or(|height| format.height() == height)
            })
            .cloned()
            .collect();
    }

    matches.sort_by(|a, b| {
        let target_rate = settings.frame_rate.unwrap_or(TARGET_CAMERA_FRAME_RATE);
        let fr_cmp_a = (a.frame_rate() - target_rate).abs();
        let fr_cmp_b = (b.frame_rate() - target_rate).abs();
        fr_cmp_a
            .partial_cmp(&fr_cmp_b)
            .unwrap_or(Ordering::Equal)
            .then((b.width() * b.height()).cmp(&(a.width() * a.height())))
    });

    matches.into_iter().next()
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn select_camera_format(
    camera: &cap_camera::CameraInfo,
    settings: Option<CameraDeviceSettings>,
) -> Result<cap_camera::Format, SetInputError> {
    let formats = camera.formats().ok_or(SetInputError::InvalidFormat)?;
    if formats.is_empty() {
        return Err(SetInputError::InvalidFormat);
    }

    if let Some(settings) = settings
        && let Some(format) = select_preferred_camera_format(&formats, settings)
    {
        return Ok(format);
    }

    let mut ideal_formats = formats
        .clone()
        .into_iter()
        .filter(|f| {
            f.frame_rate() >= PREFERRED_CAMERA_FRAME_RATE
                && f.frame_rate() <= TARGET_CAMERA_FRAME_RATE
                && f.width() <= TARGET_CAMERA_WIDTH
                && f.height() <= TARGET_CAMERA_HEIGHT
        })
        .collect::<Vec<_>>();

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .clone()
            .into_iter()
            .filter(|f| {
                f.frame_rate() >= PREFERRED_CAMERA_FRAME_RATE
                    && f.frame_rate() <= TARGET_CAMERA_FRAME_RATE
                    && f.width() < 2000
                    && f.height() < 2000
            })
            .collect::<Vec<_>>();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .clone()
            .into_iter()
            .filter(|f| {
                f.frame_rate() >= PREFERRED_CAMERA_FRAME_RATE
                    && f.width() < 2000
                    && f.height() < 2000
            })
            .collect::<Vec<_>>();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .clone()
            .into_iter()
            .filter(|f| {
                f.frame_rate() >= MIN_CAMERA_FRAME_RATE
                    && f.frame_rate() <= TARGET_CAMERA_FRAME_RATE
                    && f.width() <= TARGET_CAMERA_WIDTH
                    && f.height() <= TARGET_CAMERA_HEIGHT
            })
            .collect::<Vec<_>>();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .clone()
            .into_iter()
            .filter(|f| {
                f.frame_rate() >= MIN_CAMERA_FRAME_RATE
                    && f.frame_rate() <= TARGET_CAMERA_FRAME_RATE
                    && f.width() < 2000
                    && f.height() < 2000
            })
            .collect::<Vec<_>>();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .clone()
            .into_iter()
            .filter(|f| {
                f.frame_rate() >= MIN_CAMERA_FRAME_RATE && f.width() < 2000 && f.height() < 2000
            })
            .collect::<Vec<_>>();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats;
    };

    ideal_formats.sort_by(|a, b| {
        let target_aspect_ratio = 16.0 / 9.0;

        let aspect_ratio_a = a.width() as f32 / a.height() as f32;
        let aspect_ratio_b = b.width() as f32 / b.height() as f32;

        let aspect_cmp_a = (aspect_ratio_a - target_aspect_ratio).abs();
        let aspect_cmp_b = (aspect_ratio_b - target_aspect_ratio).abs();

        let aspect_cmp = aspect_cmp_a.partial_cmp(&aspect_cmp_b);
        let resolution_cmp = (a.width() * a.height()).cmp(&(b.width() * b.height()));
        let fr_cmp_a = (a.frame_rate() - TARGET_CAMERA_FRAME_RATE).abs();
        let fr_cmp_b = (b.frame_rate() - TARGET_CAMERA_FRAME_RATE).abs();
        let fr_cmp = fr_cmp_a.partial_cmp(&fr_cmp_b);

        aspect_cmp
            .unwrap_or(Ordering::Equal)
            .then(resolution_cmp.reverse())
            .then(fr_cmp.unwrap_or(Ordering::Equal))
    });

    Ok(ideal_formats.swap_remove(0))
}

#[cfg(target_os = "macos")]
async fn setup_camera(
    id: &DeviceOrModelID,
    settings: Option<CameraDeviceSettings>,
    recipient: Recipient<NewFrame>,
    native_recipient: Recipient<NewNativeFrame>,
    ffmpeg_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    native_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    cancel_rx: &mpsc::Receiver<()>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
    let format = select_camera_format(&camera, settings)?;

    {
        let mut fourcc = format.native().format_desc().media_sub_type().to_be_bytes();
        tracing::info!(
            camera = camera.display_name(),
            width = format.width(),
            height = format.height(),
            frame_rate = format.frame_rate(),
            pixel_format = cidre::four_cc_to_str(&mut fourcc),
            "Starting camera capture"
        );
    }

    let first_attempt = start_camera_capture_attempt(
        &camera,
        format.clone(),
        cap_camera::CaptureMode::Native,
        recipient.clone(),
        native_recipient.clone(),
        ffmpeg_sender_count.clone(),
        native_sender_count.clone(),
    )
    .await;

    match first_attempt {
        Ok(result) => Ok(result),
        // Some cameras start a session but never deliver frames when the
        // native format is pinned (seen on Apple cameras on macOS 26.4 beta).
        // Retry once letting AVFoundation negotiate everything itself.
        Err(err @ (SetInputError::Timeout(_) | SetInputError::StartCapturing(_))) => {
            if cancel_rx.try_recv().is_ok() {
                return Err(err);
            }

            warn!(
                camera = camera.display_name(),
                "Camera produced no frames in native mode ({err}), retrying in compatibility mode"
            );

            tokio::time::sleep(Duration::from_millis(150)).await;

            start_camera_capture_attempt(
                &camera,
                format,
                cap_camera::CaptureMode::Compatibility,
                recipient,
                native_recipient,
                ffmpeg_sender_count,
                native_sender_count,
            )
            .await
            .inspect(|_| {
                tracing::info!("Camera capture recovered in compatibility mode");
            })
        }
        Err(err) => Err(err),
    }
}

#[cfg(target_os = "macos")]
async fn start_camera_capture_attempt(
    camera: &cap_camera::CameraInfo,
    format: cap_camera::Format,
    mode: cap_camera::CaptureMode,
    recipient: Recipient<NewFrame>,
    native_recipient: Recipient<NewNativeFrame>,
    ffmpeg_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    native_sender_count: Arc<std::sync::atomic::AtomicUsize>,
) -> Result<SetupCameraResult, SetInputError> {
    let frame_rate = format.frame_rate().round().max(1.0) as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera
        .start_capturing_with_mode(format.clone(), mode, move |frame| {
            let callback_num =
                CAMERA_CALLBACK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let timestamp = Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::new(
                cidre::cm::Clock::convert_host_time_to_sys_units(frame.native().sample_buf().pts()),
            ));

            if native_sender_count.load(std::sync::atomic::Ordering::Relaxed) > 0 {
                let _ = native_recipient
                    .tell(NewNativeFrame(NativeCameraFrame {
                        sample_buf: frame.native().sample_buf().clone(),
                        timestamp,
                    }))
                    .try_send();
            }

            // Until the ready signal fires the first frame must still be
            // converted to derive VideoInfo; afterwards skip the full-frame
            // copy entirely when nothing consumes ffmpeg frames.
            if ready_signal.is_none()
                && ffmpeg_sender_count.load(std::sync::atomic::Ordering::Acquire) == 0
            {
                return;
            }

            let Ok(mut ff_frame) = frame.as_ffmpeg() else {
                return;
            };

            ff_frame.set_pts(Some(frame.timestamp.as_micros() as i64));

            if let Some(signal) = ready_signal.take() {
                let video_info = VideoInfo::from_raw_ffmpeg(
                    ff_frame.format(),
                    ff_frame.width(),
                    ff_frame.height(),
                    frame_rate,
                );

                let _ = signal.send(video_info);
            }

            let send_result = recipient
                .tell(NewFrame(FFmpegVideoFrame {
                    inner: ff_frame,
                    timestamp,
                }))
                .try_send();

            if send_result.is_err() && callback_num.is_multiple_of(30) {
                tracing::warn!(
                    "Camera callback: failed to send frame {} to actor (mailbox full?)",
                    callback_num
                );
            }
        })
        .map_err(|e| SetInputError::StartCapturing(e.to_string()))?;

    let video_info = tokio::time::timeout(CAMERA_INIT_TIMEOUT, ready_rx)
        .await
        .map_err(|e| SetInputError::Timeout(e.to_string()))?
        .map_err(|_| SetInputError::Initialisation)?;

    Ok(SetupCameraResult {
        handle: capture_handle,
        camera_info: camera.clone(),
        video_info,
    })
}

#[cfg(windows)]
async fn setup_camera(
    id: &DeviceOrModelID,
    settings: Option<CameraDeviceSettings>,
    recipient: Recipient<NewFrame>,
    native_recipient: Recipient<NewNativeFrame>,
    ffmpeg_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    native_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    _cancel_rx: &mpsc::Receiver<()>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
    let format = select_camera_format(&camera, settings)?;
    let frame_rate = format.frame_rate().round().max(1.0) as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera
        .start_capturing(format.clone(), move |frame| {
            let callback_num =
                CAMERA_CALLBACK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let timestamp = Timestamp::PerformanceCounter(
                cap_timestamp::PerformanceCounterTimestamp::new(frame.native().perf_counter),
            );

            if native_sender_count.load(std::sync::atomic::Ordering::Relaxed) > 0
                && let Ok(bytes) = frame.native().bytes()
            {
                use cap_mediafoundation_utils::IMFMediaBufferExt;
                use windows::Win32::Media::MediaFoundation::MFCreateMemoryBuffer;

                let data_len = bytes.len();
                if let Ok(buffer) = unsafe { MFCreateMemoryBuffer(data_len as u32) } {
                    let buffer_ready = {
                        if let Ok(mut lock) = buffer.lock_for_write() {
                            lock.copy_from_slice(&bytes);
                            true
                        } else {
                            false
                        }
                    };

                    if buffer_ready {
                        let _ = unsafe { buffer.SetCurrentLength(data_len as u32) };

                        #[allow(clippy::arc_with_non_send_sync)]
                        let buffer = std::sync::Arc::new(std::sync::Mutex::new(buffer));
                        let _ = native_recipient
                            .tell(NewNativeFrame(NativeCameraFrame {
                                buffer,
                                pixel_format: frame.native().pixel_format,
                                width: frame.native().width as u32,
                                height: frame.native().height as u32,
                                is_bottom_up: frame.native().is_bottom_up,
                                timestamp,
                            }))
                            .try_send();
                    }
                }
            }

            // Until the ready signal fires the first frame must still be
            // converted to derive VideoInfo; afterwards skip the full-frame
            // copy entirely when nothing consumes ffmpeg frames.
            if ready_signal.is_none()
                && ffmpeg_sender_count.load(std::sync::atomic::Ordering::Acquire) == 0
            {
                return;
            }

            let Ok(mut ff_frame) = frame.as_ffmpeg() else {
                return;
            };

            ff_frame.set_pts(Some(frame.timestamp.as_micros() as i64));

            if let Some(signal) = ready_signal.take() {
                let video_info = VideoInfo::from_raw_ffmpeg(
                    ff_frame.format(),
                    ff_frame.width(),
                    ff_frame.height(),
                    frame_rate,
                );

                let _ = signal.send(video_info);
            }

            let send_result = recipient
                .tell(NewFrame(FFmpegVideoFrame {
                    inner: ff_frame,
                    timestamp,
                }))
                .try_send();

            if send_result.is_err() && callback_num.is_multiple_of(30) {
                tracing::warn!(
                    "Camera callback: failed to send frame {} to actor (mailbox full?)",
                    callback_num
                );
            }
        })
        .map_err(|e| SetInputError::StartCapturing(e.to_string()))?;

    let video_info = tokio::time::timeout(CAMERA_INIT_TIMEOUT, ready_rx)
        .await
        .map_err(|e| SetInputError::Timeout(e.to_string()))?
        .map_err(|_| SetInputError::Initialisation)?;

    Ok(SetupCameraResult {
        handle: capture_handle,
        camera_info: camera,
        video_info,
    })
}

#[cfg(target_os = "linux")]
async fn setup_camera(
    id: &DeviceOrModelID,
    settings: Option<CameraDeviceSettings>,
    recipient: Recipient<NewFrame>,
    _native_recipient: Recipient<NewNativeFrame>,
    _ffmpeg_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    _native_sender_count: Arc<std::sync::atomic::AtomicUsize>,
    _cancel_rx: &mpsc::Receiver<()>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
    let format = select_camera_format(&camera, settings)?;
    let frame_rate = format.frame_rate().round().max(1.0) as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera
        .start_capturing(format.clone(), move |frame| {
            let callback_num =
                CAMERA_CALLBACK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let timestamp = Timestamp::Instant(std::time::Instant::now());

            let Ok(mut ff_frame) = frame.as_ffmpeg() else {
                return;
            };

            ff_frame.set_pts(Some(frame.timestamp.as_micros() as i64));

            if let Some(signal) = ready_signal.take() {
                let video_info = VideoInfo::from_raw_ffmpeg(
                    ff_frame.format(),
                    ff_frame.width(),
                    ff_frame.height(),
                    frame_rate,
                );

                let _ = signal.send(video_info);
            }

            let send_result = recipient
                .tell(NewFrame(FFmpegVideoFrame {
                    inner: ff_frame,
                    timestamp,
                }))
                .try_send();

            if send_result.is_err() && callback_num.is_multiple_of(30) {
                tracing::warn!(
                    "Camera callback: failed to send frame {} to actor (mailbox full?)",
                    callback_num
                );
            }
        })
        .map_err(|e| SetInputError::StartCapturing(e.to_string()))?;

    let video_info = tokio::time::timeout(CAMERA_INIT_TIMEOUT, ready_rx)
        .await
        .map_err(|e| SetInputError::Timeout(e.to_string()))?
        .map_err(|_| SetInputError::Initialisation)?;

    Ok(SetupCameraResult {
        handle: capture_handle,
        camera_info: camera,
        video_info,
    })
}

impl Message<SetInput> for CameraFeed {
    type Reply =
        Result<BoxFuture<'static, Result<(CameraInfo, VideoInfo), SetInputError>>, SetInputError>;

    async fn handle(&mut self, msg: SetInput, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.SetInput('{:?}')", &msg.id);

        fail_err!(
            "media::feeds::camera::set_input",
            SetInputError::Initialisation
        );

        if let State::Locked { inner, .. } = &self.state
            && inner.id != msg.id
        {
            return Err(SetInputError::Locked(FeedLockedError));
        }

        match &self.state {
            State::Open(state) => {
                if let Some(connecting) = &state.connecting {
                    let _ = connecting.done_tx.try_send(());
                }
                if let Some(attached) = &state.attached {
                    let _ = attached.done_tx.try_send(());
                }
            }
            State::Locked { inner, .. } => {
                let _ = inner.done_tx.try_send(());
            }
        }

        self.setup_cancel.cancel();
        self.setup_cancel = tokio_util::sync::CancellationToken::new();
        self._cancel_setup = self.setup_cancel.clone().drop_guard();
        let generation = self.next_setup_generation();

        match &mut self.state {
            State::Open(state) => {
                let actor_ref = ctx.actor_ref();
                let new_frame_recipient = actor_ref.clone().recipient();
                let native_frame_recipient = actor_ref.clone().recipient();
                let id = msg.id.clone();

                let (ready, done_tx) = spawn_camera_setup(CameraSetupArgs {
                    setup_slots: self.setup_slots.clone(),
                    setup_cancel: self.setup_cancel.clone(),
                    id: id.clone(),
                    generation,
                    settings: msg.settings,
                    actor_ref,
                    new_frame_recipient,
                    native_frame_recipient,
                    ffmpeg_sender_count: self.ffmpeg_sender_count.clone(),
                    native_sender_count: self.native_sender_count.clone(),
                    flow: CameraSetupFlow::Open,
                });

                state.connecting = Some(ConnectingState {
                    id: id.clone(),
                    generation,
                    ready: ready.clone().boxed(),
                    done_tx,
                });

                Ok(camera_ready_future(ready))
            }
            State::Locked { .. } => {
                let actor_ref = ctx.actor_ref();
                let new_frame_recipient = actor_ref.clone().recipient();
                let native_frame_recipient = actor_ref.clone().recipient();

                let (ready, _done_tx) = spawn_camera_setup(CameraSetupArgs {
                    setup_slots: self.setup_slots.clone(),
                    setup_cancel: self.setup_cancel.clone(),
                    id: msg.id.clone(),
                    generation,
                    settings: msg.settings,
                    actor_ref,
                    new_frame_recipient,
                    native_frame_recipient,
                    ffmpeg_sender_count: self.ffmpeg_sender_count.clone(),
                    native_sender_count: self.native_sender_count.clone(),
                    flow: CameraSetupFlow::Locked {
                        lock_generation: self.lock_generation,
                    },
                });

                Ok(camera_ready_future(ready))
            }
        }
    }
}

impl Message<RemoveInput> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.RemoveInput");

        let state = self.state.try_as_open()?;
        self.setup_cancel.cancel();

        if let Some(connecting) = state.connecting.take() {
            let _ = connecting.done_tx.try_send(());
        }

        if let Some(mut attached) = state.attached.take() {
            attached.finalize_pending_release();
            let _ = attached.done_tx.try_send(());
        }

        self.senders.clear();
        self.ffmpeg_sender_count
            .store(0, std::sync::atomic::Ordering::Release);
        self.native_senders.clear();
        self.native_sender_count
            .store(0, std::sync::atomic::Ordering::Release);

        for cb in &self.on_disconnect {
            (cb)();
        }

        Ok(())
    }
}

impl Message<AddSender> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if self
            .senders
            .iter()
            .any(|sender| sender.same_channel(&msg.0))
        {
            return;
        }

        debug!("CameraFeed: Adding new sender");
        self.senders.push(msg.0);
        self.ffmpeg_sender_count
            .store(self.senders.len(), std::sync::atomic::Ordering::Release);
    }
}

impl Message<AddNativeSender> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: AddNativeSender,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if self
            .native_senders
            .iter()
            .any(|sender| sender.same_channel(&msg.0))
        {
            return;
        }

        debug!("CameraFeed: Adding new native sender");
        self.native_senders.push(msg.0);
        self.native_sender_count.store(
            self.native_senders.len(),
            std::sync::atomic::Ordering::Release,
        );
    }
}

impl Message<RemoveSender> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: RemoveSender,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.senders.retain(|sender| !sender.same_channel(&msg.0));
        self.ffmpeg_sender_count
            .store(self.senders.len(), std::sync::atomic::Ordering::Release);
    }
}

impl Message<RemoveNativeSender> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: RemoveNativeSender,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.native_senders
            .retain(|sender| !sender.same_channel(&msg.0));
        self.native_sender_count.store(
            self.native_senders.len(),
            std::sync::atomic::Ordering::Release,
        );
    }
}

impl Message<ListenForReady> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: ListenForReady,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        match self.state {
            State::Locked { .. }
            | State::Open(OpenState {
                connecting: None, ..
            }) => {
                msg.0.send(()).ok();
            }
            _ => {
                self.on_ready.push(msg.0);
            }
        }
    }
}

impl Message<OnFeedDisconnect> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: OnFeedDisconnect,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.on_disconnect.push(msg.0);
    }
}

static CAMERA_FRAME_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn send_frame_to_camera_senders<T: Clone>(
    senders: &mut Vec<flume::Sender<T>>,
    frame: T,
    frame_num: u64,
    sender_label: &str,
) -> bool {
    // A disconnected sender whose queue is still full would otherwise never be
    // try_send'd again, leaving it (and its queued frames) retained forever.
    let len_before_retain = senders.len();
    senders.retain(|sender| !sender.is_disconnected());
    let removed_disconnected = senders.len() != len_before_retain;
    if removed_disconnected {
        debug!(
            "Removed {} closed {} senders before fanout",
            len_before_retain - senders.len(),
            sender_label
        );
    }

    let mut last_ready_sender = None;

    for (i, sender) in senders.iter().enumerate() {
        if sender.is_full() {
            if frame_num.is_multiple_of(30) {
                warn!(
                    "{} sender {} channel full at frame {}, dropping frame",
                    sender_label, i, frame_num
                );
            }
        } else {
            last_ready_sender = Some(i);
        }
    }

    let Some(last_ready_sender) = last_ready_sender else {
        return removed_disconnected;
    };

    let mut frame = Some(frame);
    let mut to_remove = vec![];

    for (i, sender) in senders.iter().enumerate().take(last_ready_sender + 1) {
        if sender.is_full() {
            continue;
        }

        let send_result = if i == last_ready_sender {
            let Some(frame) = frame.take() else {
                break;
            };
            sender.try_send(frame)
        } else {
            let Some(frame) = frame.as_ref() else {
                break;
            };
            sender.try_send((*frame).clone())
        };

        match send_result {
            Ok(()) => {}
            Err(flume::TrySendError::Full(_)) => {
                if frame_num.is_multiple_of(30) {
                    warn!(
                        "{} sender {} channel full at frame {}, dropping frame",
                        sender_label, i, frame_num
                    );
                }
            }
            Err(flume::TrySendError::Disconnected(_)) => {
                debug!(
                    "{} sender {} closed at frame {}, will be removed",
                    sender_label, i, frame_num
                );
                to_remove.push(i);
            }
        }
    }

    if to_remove.is_empty() {
        return removed_disconnected;
    }

    debug!(
        "Removing {} closed {} senders",
        to_remove.len(),
        sender_label
    );
    for i in to_remove.into_iter().rev() {
        senders.swap_remove(i);
    }
    true
}

impl Message<NewFrame> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: NewFrame, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let frame_num = CAMERA_FRAME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        if send_frame_to_camera_senders(&mut self.senders, msg.0, frame_num, "Camera") {
            self.ffmpeg_sender_count
                .store(self.senders.len(), std::sync::atomic::Ordering::Release);
        }
    }
}

static NATIVE_CAMERA_FRAME_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

impl Message<NewNativeFrame> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: NewNativeFrame,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let frame_num =
            NATIVE_CAMERA_FRAME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        if send_frame_to_camera_senders(&mut self.native_senders, msg.0, frame_num, "Native camera")
        {
            self.native_sender_count.store(
                self.native_senders.len(),
                std::sync::atomic::Ordering::Release,
            );
        }
    }
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum LockFeedError {
    #[error(transparent)]
    Locked(#[from] FeedLockedError),
    #[error("NoInput")]
    NoInput,
    #[error("InitializeFailed/{0}")]
    InitializeFailed(#[from] SetInputError),
}

impl Message<Lock> for CameraFeed {
    type Reply = Result<CameraFeedLock, LockFeedError>;

    async fn handle(&mut self, _: Lock, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.Lock");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &mut state.connecting {
            let ready = &mut connecting.ready;
            let result = tokio::time::timeout(CAMERA_READY_TIMEOUT, ready)
                .await
                .unwrap_or_else(|error| Err(SetInputError::Timeout(error.to_string())));
            let data = match result {
                Ok(data) => data,
                Err(error) => {
                    connecting.ready = futures::future::ready(Err(error.clone())).boxed();
                    self.setup_cancel.cancel();
                    return Err(error.into());
                }
            };

            if state.handle_input_connected(data) {
                if let Some(attached) = &mut state.attached {
                    attached.finalize_pending_release();
                }

                for tx in self.on_ready.drain(..) {
                    let _ = tx.send(());
                }
            }
        }

        let Some(attached) = state.attached.take() else {
            return Err(LockFeedError::NoInput);
        };

        let camera_info = attached.camera_info.clone();
        let video_info = attached.video_info;

        self.lock_generation += 1;
        let generation = self.lock_generation;
        let token = Arc::new(());
        let token_weak = Arc::downgrade(&token);

        self.state = State::Locked {
            inner: attached,
            token: token_weak,
        };

        let (drop_tx, drop_rx) = oneshot::channel();

        let actor_ref = ctx.actor_ref();
        tokio::spawn(async move {
            let _ = drop_rx.await;
            let _ = actor_ref.tell(Unlock { generation }).await;
        });

        Ok(CameraFeedLock {
            camera_info,
            video_info,
            actor: ctx.actor_ref(),
            drop_tx: Some(drop_tx),
            _token: token,
        })
    }
}

impl Message<InputConnected> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("CameraFeed.InputConnected");

        if self.setup_cancel.is_cancelled() {
            return;
        }

        // Lock can consume this connection before the notification reaches the mailbox.
        let Ok(state) = self.state.try_as_open() else {
            return;
        };

        if state.handle_input_connected(msg) {
            if let Some(attached) = &mut state.attached {
                attached.finalize_pending_release();
            }

            for tx in &mut self.on_ready.drain(..) {
                tx.send(()).ok();
            }
        }
    }
}

impl Message<InputConnectFailed> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("CameraFeed.InputConnectFailed");

        let Ok(state) = self.state.try_as_open() else {
            return;
        };

        let should_clear = state.connecting.as_ref().is_some_and(|connecting| {
            connecting.id == msg.id && connecting.generation == msg.generation
        });

        if should_clear {
            if let Some(connecting) = state.connecting.take() {
                let _ = connecting.done_tx.try_send(());
            }
            if let Some(mut attached) = state.attached.take() {
                attached.finalize_pending_release();
                let _ = attached.done_tx.try_send(());
            }

            for tx in &mut self.on_ready.drain(..) {
                tx.send(()).ok();
            }
        }
    }
}

impl Message<LockedCameraInputReconnected> for CameraFeed {
    type Reply = bool;

    async fn handle(
        &mut self,
        msg: LockedCameraInputReconnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if self.setup_generation == msg.generation
            && self.lock_generation == msg.lock_generation
            && !self.setup_cancel.is_cancelled()
            && let State::Locked { inner, token } = &mut self.state
            && inner.id == msg.id
            && token.strong_count() > 0
        {
            let id = msg.id;
            inner.stage_pending_release();
            inner.overwrite(
                id.clone(),
                InputConnected {
                    generation: msg.generation,
                    id,
                    done_tx: msg.done_tx,
                    camera_info: msg.camera_info,
                    video_info: msg.video_info,
                },
            );
            true
        } else {
            false
        }
    }
}

impl Message<FinalizePendingRelease> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: FinalizePendingRelease,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if self.setup_generation != msg.generation {
            return;
        }
        match &mut self.state {
            State::Open(OpenState { attached, .. }) => {
                if let Some(attached) = attached
                    && attached.id == msg.id
                {
                    attached.finalize_pending_release();
                }
            }
            State::Locked { inner, .. } => {
                if inner.id == msg.id {
                    inner.finalize_pending_release();
                }
            }
        }
    }
}

impl Message<Unlock> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: Unlock, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.Unlock(gen={})", msg.generation);

        if msg.generation != self.lock_generation {
            trace!(
                "Ignoring stale camera unlock (msg gen {} != current {})",
                msg.generation, self.lock_generation
            );
            return;
        }

        replace_with_or_abort(&mut self.state, |state| {
            if let State::Locked { inner, .. } = state {
                State::Open(OpenState {
                    connecting: None,
                    attached: Some(inner),
                })
            } else {
                state
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_camera_connection(generation: u64) -> (InputConnected, mpsc::Receiver<()>) {
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let connection = InputConnected {
            id: DeviceOrModelID::DeviceID("test-camera".to_string()),
            generation,
            done_tx,
            camera_info: serde_json::from_value(serde_json::json!({
                "device_id": "test-camera",
                "model_id": null,
                "display_name": "Test camera"
            }))
            .unwrap(),
            video_info: VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::BGRA, 16, 16, 30),
        };
        (connection, done_rx)
    }

    struct AttachedCamera;

    impl Message<AttachedCamera> for CameraFeed {
        type Reply = Option<DeviceOrModelID>;

        async fn handle(
            &mut self,
            _: AttachedCamera,
            _: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            match &self.state {
                State::Open(state) => state.attached.as_ref().map(|attached| attached.id.clone()),
                State::Locked { inner, .. } => Some(inner.id.clone()),
            }
        }
    }

    #[tokio::test]
    async fn camera_readiness_timeout_cancels_native_work_and_success_stays_attached() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let (native_tx, native_rx) = oneshot::channel();
        let ready = bounded_camera_ready(
            async move { native_rx.await.unwrap() }.boxed(),
            cancel.clone(),
            Duration::from_millis(20),
        );
        assert!(matches!(ready.await, Err(SetInputError::Timeout(_))));
        assert!(cancel.is_cancelled());
        assert!(native_tx.is_closed());

        let cancel = tokio_util::sync::CancellationToken::new();
        let (connection, done_rx) = test_camera_connection(1);
        let ready = bounded_camera_ready(
            futures::future::ready(Ok(connection)).boxed(),
            cancel.clone(),
            CAMERA_READY_TIMEOUT,
        );
        let attached = ready.await.unwrap();
        assert!(!cancel.is_cancelled());
        assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        drop(attached);
    }

    #[tokio::test]
    async fn dropping_camera_readiness_cancels_queued_work_before_native_spawn() {
        let slots = Arc::new(tokio::sync::Semaphore::new(0));
        let cancel = tokio_util::sync::CancellationToken::new();
        let ready = bounded_camera_ready(
            futures::future::pending().boxed(),
            cancel.clone(),
            CAMERA_READY_TIMEOUT,
        );
        let (started_tx, started_rx) = flume::bounded(1);
        let queued = tokio::spawn(spawn_camera_worker(slots.clone(), cancel, move |_| {
            started_tx.send(()).unwrap();
        }));
        tokio::task::yield_now().await;
        drop(ready);
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), queued)
                .await
                .unwrap()
                .unwrap(),
            Err(SetInputError::SetupCancelled)
        ));
        slots.add_permits(1);
        assert!(started_rx.is_empty());
    }

    #[tokio::test]
    async fn camera_stuck_setups_bound_workers_without_holding_slots_for_live_capture() {
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CAMERA_SETUPS));
        let (started_tx, started_rx) = flume::bounded(MAX_CONCURRENT_CAMERA_SETUPS + 1);
        let (stopped_tx, stopped_rx) = flume::bounded(MAX_CONCURRENT_CAMERA_SETUPS + 1);
        let mut release = Vec::new();
        for _ in 0..MAX_CONCURRENT_CAMERA_SETUPS {
            let (release_tx, release_rx) = mpsc::channel();
            release.push(release_tx);
            let started = started_tx.clone();
            let stopped = stopped_tx.clone();
            spawn_camera_worker(
                slots.clone(),
                tokio_util::sync::CancellationToken::new(),
                move |permit| {
                    started.send(()).unwrap();
                    release_rx.recv().unwrap();
                    drop(permit);
                    stopped.send(()).unwrap();
                },
            )
            .await
            .unwrap();
        }
        for _ in 0..MAX_CONCURRENT_CAMERA_SETUPS {
            started_rx.recv_async().await.unwrap();
        }
        assert_eq!(slots.available_permits(), 0);
        for _ in 0..32 {
            let cancel = tokio_util::sync::CancellationToken::new();
            let started = started_tx.clone();
            let queued = tokio::spawn(spawn_camera_worker(
                slots.clone(),
                cancel.clone(),
                move |_| started.send(()).unwrap(),
            ));
            tokio::task::yield_now().await;
            cancel.cancel();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(1), queued)
                    .await
                    .unwrap()
                    .unwrap(),
                Err(SetInputError::SetupCancelled)
            ));
        }
        assert!(started_rx.is_empty());
        release[0].send(()).unwrap();
        stopped_rx.recv_async().await.unwrap();

        let (capture_stop_tx, capture_stop_rx) = mpsc::channel();
        spawn_camera_worker(
            slots.clone(),
            tokio_util::sync::CancellationToken::new(),
            move |permit| {
                drop(permit);
                started_tx.send(()).unwrap();
                capture_stop_rx.recv().unwrap();
                stopped_tx.send(()).unwrap();
            },
        )
        .await
        .unwrap();
        started_rx.recv_async().await.unwrap();
        assert_eq!(slots.available_permits(), 1);
        capture_stop_tx.send(()).unwrap();
        stopped_rx.recv_async().await.unwrap();
        for release in &release[1..] {
            release.send(()).unwrap();
            stopped_rx.recv_async().await.unwrap();
        }
        assert_eq!(slots.available_permits(), MAX_CONCURRENT_CAMERA_SETUPS);
        assert!(started_rx.is_empty());
    }

    #[tokio::test]
    async fn camera_reselection_and_removal_cancel_queued_attempts() {
        let slots = Arc::new(tokio::sync::Semaphore::new(0));
        let camera = CameraFeed {
            setup_slots: slots.clone(),
            ..CameraFeed::default()
        };
        let feed = CameraFeed::spawn(camera);
        let mut pending = Vec::new();
        for _ in 0..32 {
            pending.push(
                feed.ask(SetInput {
                    id: DeviceOrModelID::DeviceID("queued-camera".into()),
                    settings: None,
                })
                .await
                .unwrap(),
            );
        }
        feed.ask(RemoveInput).await.unwrap();
        for ready in pending {
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(1), ready)
                    .await
                    .unwrap(),
                Err(SetInputError::SetupCancelled)
            ));
        }
        assert!(feed.ask(AttachedCamera).await.unwrap().is_none());
        assert_eq!(slots.available_permits(), 0);
        feed.kill();
        feed.wait_for_stop().await;
    }

    #[tokio::test]
    async fn stopping_camera_actor_cancels_queued_setup() {
        let feed = CameraFeed::spawn(CameraFeed {
            setup_slots: Arc::new(tokio::sync::Semaphore::new(0)),
            ..CameraFeed::default()
        });
        let ready = feed
            .ask(SetInput {
                id: DeviceOrModelID::DeviceID("queued-camera".into()),
                settings: None,
            })
            .await
            .unwrap();
        feed.kill();
        feed.wait_for_stop().await;
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), ready)
                .await
                .unwrap(),
            Err(SetInputError::SetupCancelled)
        ));
    }

    #[tokio::test]
    async fn cancelled_camera_setup_cannot_attach_a_late_success() {
        let (connection, done_rx) = test_camera_connection(1);
        let camera = CameraFeed {
            setup_generation: 1,
            state: State::Open(OpenState {
                connecting: Some(ConnectingState {
                    id: connection.id.clone(),
                    generation: 1,
                    ready: futures::future::pending().boxed(),
                    done_tx: connection.done_tx.clone(),
                }),
                attached: None,
            }),
            ..CameraFeed::default()
        };
        camera.setup_cancel.cancel();
        let feed = CameraFeed::spawn(camera);
        feed.ask(connection).await.unwrap();
        assert!(feed.ask(AttachedCamera).await.unwrap().is_none());
        feed.ask(RemoveInput).await.unwrap();
        assert!(done_rx.try_recv().is_ok());
        feed.kill();
        feed.wait_for_stop().await;
    }

    async fn locked_test_camera() -> (
        ActorRef<CameraFeed>,
        CameraFeedLock,
        InputConnected,
        oneshot::Receiver<()>,
    ) {
        let (connection, _done_rx) = test_camera_connection(1);
        let (ready_tx, ready_rx) = oneshot::channel();
        let camera = CameraFeed {
            setup_generation: 1,
            state: State::Open(OpenState {
                connecting: Some(ConnectingState {
                    id: connection.id.clone(),
                    generation: connection.generation,
                    ready: futures::future::ready(Ok(connection.clone())).boxed(),
                    done_tx: connection.done_tx.clone(),
                }),
                attached: None,
            }),
            on_ready: vec![ready_tx],
            ..CameraFeed::default()
        };
        let feed = CameraFeed::spawn(camera);
        let lock = feed.ask(Lock).await.unwrap();
        (feed, lock, connection, ready_rx)
    }

    #[tokio::test]
    async fn failed_camera_reselection_cannot_lock_a_stopped_attachment() {
        let (connection, stopped) = test_camera_connection(0);
        let id = connection.id.clone();
        let camera = CameraFeed {
            setup_slots: Arc::new(tokio::sync::Semaphore::new(0)),
            state: State::Open(OpenState {
                connecting: None,
                attached: Some(AttachedState::new(id.clone(), connection)),
            }),
            ..CameraFeed::default()
        };
        let feed = CameraFeed::spawn(camera);
        let selection = feed
            .ask(SetInput {
                id: id.clone(),
                settings: None,
            })
            .await
            .unwrap();
        assert!(stopped.try_recv().is_ok());
        feed.ask(InputConnectFailed { id, generation: 1 })
            .await
            .unwrap();

        let mut unavailable = Vec::new();
        for _ in 0..2 {
            let result = feed.ask(Lock).await;
            unavailable.push(matches!(
                &result,
                Err(kameo::error::SendError::HandlerError(
                    LockFeedError::NoInput
                ))
            ));
            drop(result);
        }
        feed.ask(RemoveInput).await.unwrap();
        feed.kill();
        feed.wait_for_stop().await;
        assert!(matches!(
            selection.await,
            Err(SetInputError::SetupCancelled)
        ));
        assert_eq!(unavailable, [true, true]);
    }

    #[tokio::test]
    async fn failed_camera_selection_preserves_a_newer_attached_camera() {
        let (connection, still_running) = test_camera_connection(2);
        let id = connection.id.clone();
        let feed = CameraFeed::spawn(CameraFeed {
            setup_slots: Arc::new(tokio::sync::Semaphore::new(0)),
            ..CameraFeed::default()
        });
        let first_selection = feed
            .ask(SetInput {
                id: id.clone(),
                settings: None,
            })
            .await
            .unwrap();
        let second_selection = feed
            .ask(SetInput {
                id: id.clone(),
                settings: None,
            })
            .await
            .unwrap();
        feed.ask(connection).await.unwrap();
        for generation in [1, 2] {
            feed.ask(InputConnectFailed {
                id: id.clone(),
                generation,
            })
            .await
            .unwrap();
        }
        let lock = feed.ask(Lock).await;
        let connected = lock.is_ok();
        let running = matches!(still_running.try_recv(), Err(mpsc::TryRecvError::Empty));
        drop(lock);
        feed.ask(RemoveInput).await.unwrap();
        feed.kill();
        feed.wait_for_stop().await;
        drop(first_selection);
        drop(second_selection);
        assert!(connected);
        assert!(running);
    }

    #[tokio::test]
    async fn queued_locks_keep_camera_setup_failure_without_locking_the_previous_camera() {
        let (connection, _previous_rx) = test_camera_connection(1);
        let (done_tx, _done_rx) = mpsc::sync_channel(1);
        let ready = futures::future::ready(Err(SetInputError::BuildStreamCrashed))
            .boxed()
            .shared();
        let camera = CameraFeed {
            setup_generation: 2,
            state: State::Open(OpenState {
                connecting: Some(ConnectingState {
                    id: DeviceOrModelID::DeviceID("requested-camera".into()),
                    generation: 2,
                    ready: ready.boxed(),
                    done_tx,
                }),
                attached: Some(AttachedState::new(connection.id.clone(), connection)),
            }),
            ..CameraFeed::default()
        };
        let feed = CameraFeed::spawn(camera);
        let results = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(feed.ask(Lock), feed.ask(Lock), feed.ask(Lock))
        })
        .await
        .expect("repeated camera locks blocked the actor mailbox");
        for result in [results.0, results.1, results.2] {
            assert!(matches!(
                result,
                Err(kameo::error::SendError::HandlerError(
                    LockFeedError::InitializeFailed(SetInputError::BuildStreamCrashed)
                ))
            ));
        }
        let (sender, _receiver) = flume::bounded(1);
        feed.ask(AddSender(sender)).await.unwrap();
        feed.kill();
        feed.wait_for_stop().await;
    }

    #[tokio::test]
    async fn rejected_locked_camera_selection_does_not_stop_the_recording_camera() {
        let (connection, done_rx) = test_camera_connection(1);
        let token = Arc::new(());
        let camera = CameraFeed {
            lock_generation: 7,
            setup_generation: 1,
            state: State::Locked {
                inner: AttachedState::new(connection.id.clone(), connection),
                token: Arc::downgrade(&token),
            },
            ..CameraFeed::default()
        };
        let feed = CameraFeed::spawn(camera);
        let result = feed
            .ask(SetInput {
                id: DeviceOrModelID::DeviceID("different-camera".into()),
                settings: None,
            })
            .await;
        assert!(matches!(
            result,
            Err(kameo::error::SendError::HandlerError(
                SetInputError::Locked(_)
            ))
        ));
        assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        drop(token);
        feed.kill();
        feed.wait_for_stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn camera_removal_does_not_block_on_an_already_queued_stop() {
        let (connection, done_rx) = test_camera_connection(1);
        connection.done_tx.try_send(()).unwrap();
        let camera = CameraFeed {
            state: State::Open(OpenState {
                connecting: None,
                attached: Some(AttachedState::new(connection.id.clone(), connection)),
            }),
            ..CameraFeed::default()
        };
        let feed = CameraFeed::spawn(camera);
        let result = tokio::time::timeout(Duration::from_millis(250), feed.ask(RemoveInput)).await;
        drop(done_rx);
        feed.kill();
        feed.wait_for_stop().await;
        assert!(matches!(result, Ok(Ok(()))));
    }

    #[tokio::test]
    async fn camera_reconnect_requires_current_setup_and_a_live_recording_lock() {
        for (generation, lock_generation, live, cancelled, expected) in [
            (11, 8, true, false, false),
            (12, 7, true, false, false),
            (12, 8, false, false, false),
            (12, 8, true, true, false),
            (12, 8, true, false, true),
        ] {
            let (connection, original_rx) = test_camera_connection(10);
            let (replacement, replacement_rx) = test_camera_connection(generation);
            let mut token = Some(Arc::new(()));
            let camera = CameraFeed {
                lock_generation: 8,
                setup_generation: 12,
                state: State::Locked {
                    inner: AttachedState::new(connection.id.clone(), connection),
                    token: Arc::downgrade(token.as_ref().unwrap()),
                },
                ..CameraFeed::default()
            };
            if !live {
                drop(token.take());
            }
            if cancelled {
                camera.setup_cancel.cancel();
            }
            let feed = CameraFeed::spawn(camera);
            let id = replacement.id.clone();
            let accepted = feed
                .ask(LockedCameraInputReconnected {
                    generation,
                    lock_generation,
                    id: replacement.id,
                    camera_info: replacement.camera_info,
                    video_info: replacement.video_info,
                    done_tx: replacement.done_tx,
                })
                .await
                .unwrap();
            assert_eq!(accepted, expected);
            assert_eq!(
                matches!(replacement_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
                expected,
            );
            if accepted {
                feed.ask(FinalizePendingRelease {
                    generation: 11,
                    id: id.clone(),
                })
                .await
                .unwrap();
                assert!(matches!(
                    original_rx.try_recv(),
                    Err(mpsc::TryRecvError::Empty)
                ));
                feed.ask(FinalizePendingRelease { generation: 12, id })
                    .await
                    .unwrap();
                assert!(original_rx.try_recv().is_ok());
            }
            drop(token);
            feed.kill();
            feed.wait_for_stop().await;
        }
    }

    #[tokio::test]
    async fn camera_late_connection_notification_keeps_locked_feed_alive() {
        let (feed, lock, connection, _ready) = locked_test_camera().await;
        feed.tell(connection).await.unwrap();
        let (sender, _receiver) = flume::bounded(1);
        let result = feed.ask(AddSender(sender)).await;
        drop(lock);
        feed.kill();
        feed.wait_for_stop().await;
        assert!(
            result.is_ok(),
            "late connection notification stopped the feed: {result:?}"
        );
    }

    #[tokio::test]
    async fn camera_late_failure_notification_keeps_locked_feed_alive() {
        let (feed, lock, connection, _ready) = locked_test_camera().await;
        feed.tell(InputConnectFailed {
            id: connection.id,
            generation: connection.generation,
        })
        .await
        .unwrap();
        let (sender, _receiver) = flume::bounded(1);
        let result = feed.ask(AddSender(sender)).await;
        drop(lock);
        feed.kill();
        feed.wait_for_stop().await;
        assert!(
            result.is_ok(),
            "late failure notification stopped the feed: {result:?}"
        );
    }

    #[tokio::test]
    async fn camera_lock_notifies_waiters_when_it_consumes_the_connection() {
        let (feed, lock, _connection, mut ready) = locked_test_camera().await;
        let result = ready.try_recv();
        drop(lock);
        feed.kill();
        feed.wait_for_stop().await;
        assert!(
            result.is_ok(),
            "camera readiness was not delivered: {result:?}"
        );
    }
}
