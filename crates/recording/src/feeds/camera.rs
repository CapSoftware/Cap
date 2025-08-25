use std::{
    cmp::Ordering,
    pin::Pin,
    sync::mpsc,
    time::{Duration, Instant},
};

use cap_camera::{CameraInfo, CaptureHandle, Format};
use cap_camera_ffmpeg::CapturedFrameExt;
use cap_media_info::VideoInfo;
use ffmpeg::frame;
use flume::TrySendError;
use futures::{
    FutureExt, TryFutureExt,
    future::Shared,
    stream::{AbortHandle, Abortable},
};
use kameo::{Actor, prelude::*};
use tracing::{debug, error, info, warn};

type SharedInitTaskHandle = Abortable<
    Shared<Pin<Box<dyn Future<Output = Result<Result<(), SetupCameraError>, String>> + Send>>>,
>;

#[derive(Debug, Clone)]
pub struct CameraFeed(ActorRef<CameraFeedActor>);

impl CameraFeed {
    pub fn init() -> Self {
        Self(CameraFeedActor::spawn(Default::default()))
    }

    pub async fn set_camera(&self, id: DeviceOrModelID) -> Result<(), SetupCameraError> {
        let camera = cap_camera::list_cameras()
            .find(|c| match &id {
                DeviceOrModelID::DeviceID(device_id) => c.device_id() == device_id,
                DeviceOrModelID::ModelID(model_id) => c.model_id() == Some(model_id),
            })
            .ok_or(SetupCameraError::CameraNotFound)?;
        let formats = camera.formats().ok_or(SetupCameraError::InvalidFormat)?;
        if formats.is_empty() {
            return Err(SetupCameraError::InvalidFormat);
        }

        self.0
            .ask(SetCamera { camera, formats })
            .await
            .map_err(|_| SetupCameraError::ActorSendError)?
            .await
            // We treat the future being aborted as a success
            // As it means another camera is being initialized
            .unwrap_or(Ok(Ok(())))
            .map_err(SetupCameraError::TaskError)??;
        Ok(())
    }

    pub fn create_connection(&self) -> flume::Receiver<RawCameraFrame> {
        todo!();
    }

    pub fn video_info(&self) -> VideoInfo {
        todo!()
    }

    /// Detach the camera feed from the actor.
    pub async fn detach(&self) -> Result<(), ()> {
        self.0.ask(Detach).await.map_err(|_| ())
    }
}

impl Drop for CameraFeed {
    fn drop(&mut self) {
        let actor = self.0.clone();
        tokio::spawn(async move {
            actor
                .stop_gracefully()
                .await
                .map_err(|err| error!("Error stopping camera feed: {err:?}"))
                .ok();
        });
    }
}

#[derive(Actor, Default)]
struct CameraFeedActor {
    senders: Vec<flume::Sender<RawCameraFrame>>,
    state: State,
}

struct AttachedCamera {
    handle: CaptureHandle,
    video_info: VideoInfo,
    reference_time: Instant,
}

#[derive(Default)]
enum State {
    #[default]
    Detached,
    Initializing {
        handle: SharedInitTaskHandle,
        abort_handle: AbortHandle,
    },
    Attached(AttachedCamera),
}

pub struct SetCamera {
    camera: CameraInfo,
    formats: Vec<Format>,
}

impl Message<SetCamera> for CameraFeedActor {
    type Reply = Result<SharedInitTaskHandle, ()>;

    async fn handle(
        &mut self,
        msg: SetCamera,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        match std::mem::replace(&mut self.state, State::Detached) {
            State::Detached => {}
            State::Initializing { abort_handle, .. } => {
                info!("Switching initializing camera feed");
                abort_handle.abort();
            }
            State::Attached(camera) => {
                info!("Switching existing camera feed");
                camera
                    .handle
                    .stop_capturing()
                    .map_err(|err| error!("Failed to stop capturing: {err}"))
                    .ok();
            }
        }

        let actor = ctx.actor_ref();
        let actor_ref = actor.clone();
        let handle = tokio::spawn(async move {
            let actor_ref2 = actor_ref.clone();

            let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
            let mut ready_signal = Some(ready_tx);

            let format = determine_idea_format(msg.formats);
            let frame_rate = format.frame_rate() as u32;

            let capture_handle = msg.camera.start_capturing(format, move |frame| {
                let Ok(mut ff_frame) = frame.to_ffmpeg() else {
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

                    let _ = signal.send((video_info, frame.reference_time));
                }

                actor_ref2
                    .tell(FrameReady(RawCameraFrame {
                        frame: ff_frame,
                        timestamp: frame.timestamp,
                        reference_time: frame.reference_time,
                    }))
                    .blocking_send()
                    .map_err(|err| error!("Error sending camera frame to actor: {err}"))
                    .ok();
            })?;

            let (video_info, reference_time) = ready_rx
                .recv_timeout(CAMERA_INIT_TIMEOUT)
                .map_err(SetupCameraError::Timeout)?;

            actor_ref
                .tell(CameraReady(Ok(AttachedCamera {
                    handle: capture_handle,
                    video_info,
                    reference_time,
                })))
                .await
                .map_err(|err| error!("Error sending camera ready message to actor: {err}"))
                .ok();

            Ok::<_, SetupCameraError>(())
        })
        .map_err(|err| format!("Error joining camera feed actor task: {err}"))
        .boxed()
        .shared();

        let (abort_handle, abort_registration) = AbortHandle::new_pair();
        let handle = Abortable::new(handle, abort_registration);

        // We use a separate actor so panics and errors can be caught.
        tokio::spawn({
            let handle = handle.clone();
            async move {
                if handle
                    .await
                    .map(|r| r.map_err(|_| ()))
                    .map_err(|_| ())
                    .flatten()
                    .is_err()
                {
                    actor.tell(CameraReady(Err(()))).await.ok();
                }
            }
        });

        self.state = State::Initializing {
            handle: handle.clone(),
            abort_handle,
        };

        Ok(handle)
    }
}

struct CameraReady(Result<AttachedCamera, ()>);

impl Message<CameraReady> for CameraFeedActor {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: CameraReady,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        match (msg.0, &mut self.state) {
            (Ok(camera), State::Detached) => {
                // Indicates a bug in `SetCamera` but we can make it work.
                error!("Skipping camera initialization state");
                self.state = State::Attached(camera);
            }
            (Ok(camera), State::Initializing { .. }) => self.state = State::Attached(camera),
            (Ok(camera), State::Attached { .. }) => {
                // Indicates a bug in `SetCamera` but we can make it work.
                error!("CameraReady received while in attached state");
                self.state = State::Attached(camera);
            }
            (Err(_), State::Initializing { .. }) => {
                error!("Failed to attach camera, detaching it...");
                self.state = State::Detached;
            }
            (Err(_), State::Detached | State::Attached(..)) => {
                // If this is reached the handling of `SetCamera` has a bug.
                // As it won't affect UX we can just ignore it.
                error!("Error initializing camera with one already attached.");
            }
        }
    }
}

struct Detach;

impl Message<Detach> for CameraFeedActor {
    type Reply = ();

    async fn handle(&mut self, _: Detach, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        match std::mem::replace(&mut self.state, State::Detached) {
            State::Detached => {}
            State::Initializing { abort_handle, .. } => {
                abort_handle.abort();
            }
            State::Attached(camera) => {
                camera
                    .handle
                    .stop_capturing()
                    .map_err(|err| error!("Error stopping camera feed: {err}"))
                    .ok();
            }
        }
    }
}

struct FrameReady(RawCameraFrame);

impl Message<FrameReady> for CameraFeedActor {
    type Reply = ();

    async fn handle(
        &mut self,
        FrameReady(frame): FrameReady,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        // This shouldn't happen but let's guard it anyway
        if matches!(self.state, State::Detached) {
            error!("FrameRead received while in detached state. Ignoring it!");
            return;
        }

        let mut to_remove = vec![];

        for (i, sender) in self.senders.iter().enumerate() {
            if let Err(TrySendError::Disconnected(_)) = sender.try_send(frame.clone()) {
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

struct AttachConsumer(flume::Sender<RawCameraFrame>);

impl Message<AttachConsumer> for CameraFeedActor {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: AttachConsumer,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.senders.push(msg.0);
    }
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
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

#[derive(Clone)]
pub struct RawCameraFrame {
    pub frame: frame::Video,
    pub timestamp: Duration,
    pub reference_time: Instant,
}

#[derive(Debug, thiserror::Error, Clone)]
pub enum SetupCameraError {
    #[error("Camera not found")]
    CameraNotFound,
    #[error("Invalid format")]
    InvalidFormat,
    #[error("Camera timed out")]
    Timeout(mpsc::RecvTimeoutError),
    #[error("StartCapturing/{0}")]
    StartCapturing(#[from] cap_camera::StartCapturingError),
    #[error("Task error: {0}")]
    TaskError(String),
    #[error("Actor send error")]
    ActorSendError,
}

const CAMERA_INIT_TIMEOUT: Duration = Duration::from_secs(4);

pub fn determine_idea_format(formats: Vec<Format>) -> Format {
    let mut ideal_formats = formats
        .clone()
        .into_iter()
        .filter(|f| f.frame_rate() >= 30.0 && f.width() < 2000 && f.height() < 2000)
        .collect::<Vec<_>>();

    if ideal_formats.is_empty() {
        ideal_formats = formats;
    };

    // Sort formats to prioritize:
    // 1. Closest to 16:9 aspect ratio
    // 2. Highest resolution (total pixels)
    // 3. Highest frame rate
    // Most relevant ends up in index 0
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

    ideal_formats.swap_remove(0)
}
