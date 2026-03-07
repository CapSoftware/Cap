use cap_camera::CameraInfo;
use cap_camera_ffmpeg::*;
use cap_fail::fail_err;
use cap_media_info::VideoInfo;
use cap_timestamp::Timestamp;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use kameo::prelude::*;
use replace_with::replace_with_or_abort;
use std::{
    cmp::Ordering,
    ops::Deref,
    sync::mpsc::{self, SyncSender},
    time::Duration,
};
use tokio::{runtime::Runtime, sync::oneshot, task::LocalSet};
use tracing::{debug, error, info, trace, warn};

use crate::ffmpeg::FFmpegVideoFrame;
use crate::output_pipeline::NativeCameraFrame;

const CAMERA_INIT_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Actor)]
pub struct CameraFeed {
    state: State,
    senders: Vec<flume::Sender<FFmpegVideoFrame>>,
    native_senders: Vec<flume::Sender<NativeCameraFrame>>,
    on_ready: Vec<oneshot::Sender<()>>,
    on_disconnect: Vec<Box<dyn Fn() + Send>>,
}

enum State {
    Open(OpenState),
    Locked { inner: AttachedState },
}

impl State {
    fn try_as_open(&mut self) -> Result<&mut OpenState, FeedLockedError> {
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
    fn handle_input_connected(&mut self, data: InputConnected, id: DeviceOrModelID) -> bool {
        if let Some(connecting) = &self.connecting
            && id == connecting.id
        {
            trace!("Attaching new camera");

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
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
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
        } = data;

        self.id = id;
        self.camera_info = camera_info;
        self.video_info = video_info;
        self.done_tx = done_tx;
    }

    fn stage_pending_release(&mut self) {
        if let Some(pending) = self.pending_release.take() {
            let _ = pending.send(());
        }

        self.pending_release = Some(self.done_tx.clone());
    }

    fn finalize_pending_release(&mut self) {
        if let Some(pending) = self.pending_release.take() {
            let _ = pending.send(());
        }
    }
}

impl Default for CameraFeed {
    fn default() -> Self {
        Self {
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
            native_senders: Vec::new(),
            on_ready: Vec::new(),
            on_disconnect: Vec::new(),
        }
    }
}

#[derive(Reply)]
pub struct CameraFeedLock {
    actor: ActorRef<CameraFeed>,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    drop_tx: Option<oneshot::Sender<()>>,
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

// Public Requests

pub struct SetInput {
    pub id: DeviceOrModelID,
}

pub struct RemoveInput;

pub struct AddSender(pub flume::Sender<FFmpegVideoFrame>);

pub struct AddNativeSender(pub flume::Sender<NativeCameraFrame>);

pub struct ListenForReady(pub oneshot::Sender<()>);

pub struct OnFeedDisconnect(pub Box<dyn Fn() + Send>);

pub struct Lock;

// Private Events

#[derive(Clone)]
struct InputConnected {
    done_tx: SyncSender<()>,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
}

type ReadyFuture = Shared<BoxFuture<'static, Result<InputConnected, SetInputError>>>;

#[derive(Clone, Copy)]
enum CameraSetupFlow {
    Open,
    Locked,
}

struct InputConnectFailed {
    id: DeviceOrModelID,
}

struct LockedCameraInputReconnected {
    id: DeviceOrModelID,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    done_tx: SyncSender<()>,
}

struct NewFrame(FFmpegVideoFrame);

struct NewNativeFrame(NativeCameraFrame);

struct Unlock;

struct FinalizePendingRelease {
    id: DeviceOrModelID,
}

fn spawn_camera_setup(
    id: DeviceOrModelID,
    actor_ref: ActorRef<CameraFeed>,
    new_frame_recipient: Recipient<NewFrame>,
    native_frame_recipient: Recipient<NewNativeFrame>,
    flow: CameraSetupFlow,
) -> (ReadyFuture, SyncSender<()>) {
    let (ready_tx, ready_rx) = oneshot::channel::<Result<InputConnected, SetInputError>>();
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(0);

    let ready = ready_rx
        .map(|v| {
            v.map_err(|_| SetInputError::BuildStreamCrashed)
                .and_then(|v| v)
        })
        .boxed()
        .shared();

    let runtime = Runtime::new().expect("Failed to get Tokio runtime!");
    let done_rx_thread = done_rx;
    let done_tx_thread = done_tx.clone();
    let ready_tx_thread = ready_tx;

    std::thread::spawn(move || {
        LocalSet::new().block_on(&runtime, async move {
            let setup_result = setup_camera(&id, new_frame_recipient, native_frame_recipient).await;

            let handle = match setup_result {
                Ok(result) => {
                    let SetupCameraResult {
                        handle,
                        camera_info,
                        video_info,
                    } = result;

                    let ready_payload = InputConnected {
                        camera_info: camera_info.clone(),
                        video_info,
                        done_tx: done_tx_thread.clone(),
                    };

                    match flow {
                        CameraSetupFlow::Open => {
                            let _ = ready_tx_thread.send(Ok(ready_payload.clone()));
                            let _ = actor_ref.ask(ready_payload).await;
                        }
                        CameraSetupFlow::Locked => {
                            let reconnect_result = actor_ref
                                .ask(LockedCameraInputReconnected {
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
                                        .tell(FinalizePendingRelease { id: id.clone() })
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

                    if matches!(flow, CameraSetupFlow::Open) {
                        let _ = actor_ref.tell(InputConnectFailed { id: id.clone() }).await;
                    }

                    return;
                }
            };

            info!(
                "Camera capture thread: waiting for done signal for {:?}",
                &id
            );

            drop(done_tx_thread);
            let recv_result = done_rx_thread.recv();

            warn!(
                "Camera capture thread: done signal received for {:?}, result={:?}",
                &id, recv_result
            );

            let _ = handle.stop_capturing();

            warn!("Camera capture thread: stopped capture of {:?}", &id);
        })
    });

    (ready, done_tx)
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
    #[error("InvalidFormat")]
    InvalidFormat,
    #[error("CameraTimeout")]
    Timeout(String),
    #[error("StartCapturing/{0}")]
    StartCapturing(String),
    #[error("Failed to initialize camera")]
    Initialisation,
}

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

static CAMERA_CALLBACK_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn select_camera_format(
    camera: &cap_camera::CameraInfo,
) -> Result<cap_camera::Format, SetInputError> {
    let formats = camera.formats().ok_or(SetInputError::InvalidFormat)?;
    if formats.is_empty() {
        return Err(SetInputError::InvalidFormat);
    }

    let mut ideal_formats = formats
        .clone()
        .into_iter()
        .filter(|f| f.frame_rate() >= 30.0 && f.width() < 2000 && f.height() < 2000)
        .collect::<Vec<_>>();

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
        let fr_cmp = a.frame_rate().partial_cmp(&b.frame_rate());

        aspect_cmp
            .unwrap_or(Ordering::Equal)
            .then(resolution_cmp.reverse())
            .then(fr_cmp.unwrap_or(Ordering::Equal).reverse())
    });

    Ok(ideal_formats.swap_remove(0))
}

#[cfg(target_os = "macos")]
async fn setup_camera(
    id: &DeviceOrModelID,
    recipient: Recipient<NewFrame>,
    native_recipient: Recipient<NewNativeFrame>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
    let format = select_camera_format(&camera)?;
    let frame_rate = format.frame_rate().round().max(1.0) as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera
        .start_capturing(format.clone(), move |frame| {
            let callback_num =
                CAMERA_CALLBACK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let timestamp = Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::new(
                cidre::cm::Clock::convert_host_time_to_sys_units(frame.native().sample_buf().pts()),
            ));

            let _ = native_recipient
                .tell(NewNativeFrame(NativeCameraFrame {
                    sample_buf: frame.native().sample_buf().clone(),
                    timestamp,
                }))
                .try_send();

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

#[cfg(windows)]
async fn setup_camera(
    id: &DeviceOrModelID,
    recipient: Recipient<NewFrame>,
    native_recipient: Recipient<NewNativeFrame>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
    let format = select_camera_format(&camera)?;
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

            if let Ok(bytes) = frame.native().bytes() {
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
    recipient: Recipient<NewFrame>,
    native_recipient: Recipient<NewNativeFrame>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
    let format = select_camera_format(&camera)?;
    let frame_rate = format.frame_rate().round().max(1.0) as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera
        .start_capturing(format.clone(), move |frame| {
            let callback_num =
                CAMERA_CALLBACK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let timestamp = Timestamp::Instant(std::time::Instant::now());

            let native = frame.native();
            let _ = native_recipient
                .tell(NewNativeFrame(NativeCameraFrame {
                    data: native.data.clone(),
                    width: native.width,
                    height: native.height,
                    timestamp,
                }))
                .try_send();

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

        match &mut self.state {
            State::Open(state) => {
                let actor_ref = ctx.actor_ref();
                let new_frame_recipient = actor_ref.clone().recipient();
                let native_frame_recipient = actor_ref.clone().recipient();
                let id = msg.id.clone();

                let (ready, _done_tx) = spawn_camera_setup(
                    id.clone(),
                    actor_ref,
                    new_frame_recipient,
                    native_frame_recipient,
                    CameraSetupFlow::Open,
                );

                state.connecting = Some(ConnectingState {
                    id,
                    ready: ready.clone().boxed(),
                });

                Ok(ready
                    .map(|v| v.map(|v| (v.camera_info, v.video_info)))
                    .boxed())
            }
            State::Locked { inner } => {
                if inner.id != msg.id {
                    return Err(SetInputError::Locked(FeedLockedError));
                }

                let actor_ref = ctx.actor_ref();
                let new_frame_recipient = actor_ref.clone().recipient();
                let native_frame_recipient = actor_ref.clone().recipient();

                let (ready, _done_tx) = spawn_camera_setup(
                    msg.id.clone(),
                    actor_ref,
                    new_frame_recipient,
                    native_frame_recipient,
                    CameraSetupFlow::Locked,
                );

                Ok(ready
                    .map(|v| v.map(|v| (v.camera_info, v.video_info)))
                    .boxed())
            }
        }
    }
}

impl Message<RemoveInput> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.RemoveInput");

        let state = self.state.try_as_open()?;

        state.connecting = None;

        if let Some(mut attached) = state.attached.take() {
            attached.finalize_pending_release();
            let _ = attached.done_tx.send(());
        }

        self.senders.clear();
        self.native_senders.clear();

        for cb in &self.on_disconnect {
            (cb)();
        }

        Ok(())
    }
}

impl Message<AddSender> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        debug!("CameraFeed: Adding new sender");
        self.senders.push(msg.0);
    }
}

impl Message<AddNativeSender> for CameraFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: AddNativeSender,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        debug!("CameraFeed: Adding new native sender");
        self.native_senders.push(msg.0);
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

impl Message<NewFrame> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: NewFrame, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let frame_num = CAMERA_FRAME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let mut to_remove = vec![];

        for (i, sender) in self.senders.iter().enumerate() {
            match sender.try_send(msg.0.clone()) {
                Ok(()) => {}
                Err(flume::TrySendError::Full(_)) => {
                    if frame_num.is_multiple_of(30) {
                        warn!(
                            "Camera sender {} channel full at frame {}, dropping frame",
                            i, frame_num
                        );
                    }
                }
                Err(flume::TrySendError::Disconnected(_)) => {
                    warn!(
                        "Camera sender {} disconnected at frame {}, will be removed",
                        i, frame_num
                    );
                    to_remove.push(i);
                }
            }
        }

        if !to_remove.is_empty() {
            debug!("Removing {} disconnected camera senders", to_remove.len());
            for i in to_remove.into_iter().rev() {
                self.senders.swap_remove(i);
            }
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

        let mut to_remove = vec![];

        for (i, sender) in self.native_senders.iter().enumerate() {
            match sender.try_send(msg.0.clone()) {
                Ok(()) => {}
                Err(flume::TrySendError::Full(_)) => {
                    if frame_num.is_multiple_of(30) {
                        warn!(
                            "Native camera sender {} channel full at frame {}, dropping frame",
                            i, frame_num
                        );
                    }
                }
                Err(flume::TrySendError::Disconnected(_)) => {
                    warn!(
                        "Native camera sender {} disconnected at frame {}, will be removed",
                        i, frame_num
                    );
                    to_remove.push(i);
                }
            }
        }

        if !to_remove.is_empty() {
            debug!(
                "Removing {} disconnected native camera senders",
                to_remove.len()
            );
            for i in to_remove.into_iter().rev() {
                self.native_senders.swap_remove(i);
            }
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
            let id = connecting.id.clone();
            let ready = &mut connecting.ready;
            let data = ready.await?;

            if state.handle_input_connected(data, id)
                && let Some(attached) = &mut state.attached
            {
                attached.finalize_pending_release();
            }
        }

        let Some(attached) = state.attached.take() else {
            return Err(LockFeedError::NoInput);
        };

        let camera_info = attached.camera_info.clone();
        let video_info = attached.video_info;

        self.state = State::Locked { inner: attached };

        let (drop_tx, drop_rx) = oneshot::channel();

        let actor_ref = ctx.actor_ref();
        tokio::spawn(async move {
            let _ = drop_rx.await;
            let _ = actor_ref.tell(Unlock).await;
        });

        Ok(CameraFeedLock {
            camera_info,
            video_info,
            actor: ctx.actor_ref(),
            drop_tx: Some(drop_tx),
        })
    }
}

impl Message<InputConnected> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        _: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("CameraFeed.InputConnected");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &mut state.connecting {
            let id = connecting.id.clone();
            let ready = &mut connecting.ready;
            let res = ready.await;

            if let Ok(data) = res
                && state.handle_input_connected(data, id)
                && let Some(attached) = &mut state.attached
            {
                attached.finalize_pending_release();
            }
        }

        for tx in &mut self.on_ready.drain(..) {
            tx.send(()).ok();
        }

        Ok(())
    }
}

impl Message<InputConnectFailed> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("CameraFeed.InputConnectFailed");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &state.connecting
            && connecting.id == msg.id
        {
            state.connecting = None;

            for tx in &mut self.on_ready.drain(..) {
                tx.send(()).ok();
            }
        }

        Ok(())
    }
}

impl Message<LockedCameraInputReconnected> for CameraFeed {
    type Reply = bool;

    async fn handle(
        &mut self,
        msg: LockedCameraInputReconnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if let State::Locked { inner } = &mut self.state
            && inner.id == msg.id
        {
            inner.stage_pending_release();
            inner.overwrite(
                msg.id,
                InputConnected {
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
        match &mut self.state {
            State::Open(OpenState { attached, .. }) => {
                if let Some(attached) = attached
                    && attached.id == msg.id
                {
                    attached.finalize_pending_release();
                }
            }
            State::Locked { inner } => {
                if inner.id == msg.id {
                    inner.finalize_pending_release();
                }
            }
        }
    }
}

impl Message<Unlock> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, _: Unlock, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.Unlock");

        replace_with_or_abort(&mut self.state, |state| {
            if let State::Locked { inner } = state {
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
