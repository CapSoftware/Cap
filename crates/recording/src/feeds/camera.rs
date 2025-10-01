use cap_camera::CameraInfo;
use cap_camera_ffmpeg::*;
use cap_fail::fail_err;
use cap_media_info::VideoInfo;
#[cfg(windows)]
use cap_timestamp::PerformanceCounterTimestamp;
use cap_timestamp::Timestamp;
use ffmpeg::frame;
use futures::{FutureExt, future::BoxFuture};
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

const CAMERA_INIT_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub struct RawCameraFrame {
    pub frame: frame::Video,
    pub timestamp: Timestamp,
}

#[derive(Actor)]
pub struct CameraFeed {
    state: State,
    senders: Vec<flume::Sender<RawCameraFrame>>,
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
    fn handle_input_connected(&mut self, data: InputConnected, id: DeviceOrModelID) {
        if let Some(connecting) = &self.connecting
            && id == connecting.id
        {
            if let Some(attached) = self.attached.take() {
                let _ = attached.done_tx.send(());
            }

            trace!("Attaching new camera");

            self.attached = Some(AttachedState {
                id,
                camera_info: data.camera_info,
                video_info: data.video_info,
                done_tx: data.done_tx,
            });
            self.connecting = None;
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
}

impl Default for CameraFeed {
    fn default() -> Self {
        Self {
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
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

pub struct AddSender(pub flume::Sender<RawCameraFrame>);

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

struct InputConnectFailed {
    id: DeviceOrModelID,
}

struct NewFrame(RawCameraFrame);

struct Unlock;

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
    // frame_rx: mpsc::Receiver<RawCameraFrame>,
}

async fn setup_camera(
    id: &DeviceOrModelID,
    recipient: Recipient<NewFrame>,
) -> Result<SetupCameraResult, SetInputError> {
    let camera = find_camera(id).ok_or(SetInputError::DeviceNotFound)?;
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

    let format = ideal_formats.swap_remove(0);

    let frame_rate = format.frame_rate() as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera
        .start_capturing(format.clone(), move |frame| {
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

            let _ = recipient
                .tell(NewFrame(RawCameraFrame {
                    frame: ff_frame,
                    #[cfg(windows)]
                    timestamp: Timestamp::PerformanceCounter(PerformanceCounterTimestamp::new(
                        frame.native().perf_counter,
                    )),
                    #[cfg(target_os = "macos")]
                    timestamp: Timestamp::MachAbsoluteTime(
                        cap_timestamp::MachAbsoluteTimestamp::new(
                            cidre::cm::Clock::convert_host_time_to_sys_units(
                                frame.native().sample_buf().pts(),
                            ),
                        ),
                    ),
                }))
                .try_send();
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

        let state = self.state.try_as_open()?;

        let (ready_tx, ready_rx) = oneshot::channel::<Result<InputConnected, SetInputError>>();
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(0);

        let ready = ready_rx
            .map(|v| {
                v.map_err(|_| SetInputError::BuildStreamCrashed)
                    .and_then(|v| v)
            })
            .shared();

        state.connecting = Some(ConnectingState {
            id: msg.id.clone(),
            ready: ready.clone().boxed(),
        });

        let id = msg.id.clone();
        let actor_ref = ctx.actor_ref();
        let new_frame_recipient = actor_ref.clone().recipient();

        let rt = Runtime::new().expect("Failed to get Tokio runtime!");
        std::thread::spawn(move || {
            LocalSet::new().block_on(&rt, async move {
                let handle = match setup_camera(&id, new_frame_recipient).await {
                    Ok(r) => {
                        let _ = ready_tx.send(Ok(InputConnected {
                            camera_info: r.camera_info.clone(),
                            video_info: r.video_info,
                            done_tx: done_tx.clone(),
                        }));

                        let _ = actor_ref
                            .ask(InputConnected {
                                camera_info: r.camera_info.clone(),
                                video_info: r.video_info,
                                done_tx: done_tx.clone(),
                            })
                            .await;

                        r.handle
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.clone()));

                        let _ = actor_ref.tell(InputConnectFailed { id }).await;

                        return;
                    }
                };

                trace!("Waiting for camera to be done");

                let _ = done_rx.recv();

                trace!("Stoppping capture of {:?}", &id);

                let _ = handle.stop_capturing();

                info!("Stopped capture of {:?}", &id);
            })
        });

        Ok(ready
            .map(|v| v.map(|v| (v.camera_info, v.video_info)))
            .boxed())
    }
}

impl Message<RemoveInput> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("CameraFeed.RemoveInput");

        let state = self.state.try_as_open()?;

        state.connecting = None;

        if let Some(AttachedState { done_tx, .. }) = state.attached.take() {
            let _ = done_tx.send(());
        }

        for cb in &self.on_disconnect {
            (cb)();
        }

        Ok(())
    }
}

impl Message<AddSender> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.senders.push(msg.0);
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
                connecting: None,
                attached: Some(..),
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

impl Message<NewFrame> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: NewFrame, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let mut to_remove = vec![];

        for (i, sender) in self.senders.iter().enumerate() {
            if let Err(flume::TrySendError::Disconnected(_)) = sender.try_send(msg.0.clone()) {
                warn!("Camera sender {} disconnected, will be removed", i);
                to_remove.push(i);
            };
        }

        if !to_remove.is_empty() {
            debug!("Removing {} disconnected camera senders", to_remove.len());
            for i in to_remove.into_iter().rev() {
                self.senders.swap_remove(i);
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

            state.handle_input_connected(data, id);
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

            if let Ok(data) = res {
                state.handle_input_connected(data, id);
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
        }

        Ok(())
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
