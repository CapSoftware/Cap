use cap_media_info::VideoInfo;
use ffmpeg::frame;
use futures::future::BoxFuture;
use kameo::prelude::*;
use replace_with::replace_with_or_abort;
use std::{
    ops::Deref,
    sync::mpsc::{self, SyncSender},
    time::{Duration, Instant},
};
use tracing::{error, trace};

// TODO: Fix these
type SupportedStreamConfig = ();
type StreamError = ();

#[derive(Clone)]
pub struct RawCameraFrame {
    pub frame: frame::Video,
    pub timestamp: Duration,
    pub refrence_time: Instant,
}

#[derive(Actor)]
pub struct CameraFeed {
    state: State,
    senders: Vec<flume::Sender<RawCameraFrame>>,
    //     error_sender: flume::Sender<StreamError>,
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
    fn handle_input_connected(&mut self, data: InputConnected) {
        // if let Some(connecting) = &self.connecting
        //     && data.id == connecting.id
        // {
        //     self.attached = Some(AttachedState {
        //         id: data.id,
        //         config: data.config.clone(),
        //         done_tx: data.done_tx,
        //     });
        //     self.connecting = None;
        // }
        todo!();
    }
}

struct ConnectingState {
    id: u32,
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
}

struct AttachedState {
    id: u32,
    // config: SupportedStreamConfig,
    done_tx: mpsc::SyncSender<()>,
}

impl CameraFeed {
    pub fn new(error_sender: flume::Sender<StreamError>) -> Self {
        Self {
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
            // error_sender,
        }
    }
}

#[derive(Reply)]
pub struct CameraFeedLock {
    actor: ActorRef<CameraFeed>,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    lock_tx: Recipient<Unlock>,
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
        let _ = self.lock_tx.tell(Unlock).blocking_send();
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

// Public Requests

pub struct SetInput {
    pub id: DeviceOrModelID,
}

pub struct RemoveInput;

pub struct AddSender(pub flume::Sender<RawCameraFrame>);

pub struct Lock;

// Private Events

struct InputConnected {
    // id: u32,
    // config: SupportedStreamConfig,
    done_tx: SyncSender<()>,
}

struct InputConnectFailed {
    // id: u32,
}

struct Unlock;

// Impls

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("FeedLocked")]
pub struct FeedLockedError;

#[derive(Clone, Debug, thiserror::Error)]
pub enum SetInputError {
    // #[error(transparent)]
    // Locked(#[from] FeedLockedError),
    // #[error("DeviceNotFound")]
    // DeviceNotFound,
    // #[error("BuildStreamCrashed")]
    // BuildStreamCrashed,
    // // we use strings for these as the cpal errors aren't Clone
    // #[error("BuildStream: {0}")]
    // BuildStream(String),
    // #[error("PlayStream: {0}")]
    // PlayStream(String),
}

impl Message<SetInput> for CameraFeed {
    type Reply =
        Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>;

    async fn handle(&mut self, msg: SetInput, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        todo!();
        //         trace!("CameraFeed.SetInput('{}')", &msg.label);

        //         let state = self.state.try_as_open()?;

        //         let id = self.input_id_counter;
        //         self.input_id_counter += 1;

        //         let Some((device, config)) = Self::list().swap_remove(&msg.label) else {
        //             return Err(SetInputError::DeviceNotFound);
        //         };

        //         let sample_format = config.sample_format();

        //         let (ready_tx, ready_rx) = oneshot::channel();
        //         let (done_tx, done_rx) = mpsc::sync_channel(0);

        //         let actor_ref = ctx.actor_ref();
        //         let ready = {
        //             let config = config.clone();
        //             ready_rx
        //                 .map(|v| {
        //                     v.map_err(|_| SetInputError::BuildStreamCrashed)
        //                         .map(|_| config)
        //                 })
        //                 .shared()
        //         };
        //         let error_sender = self.error_sender.clone();

        //         state.connecting = Some(ConnectingState {
        //             id,
        //             ready: {
        //                 let done_tx = done_tx.clone();
        //                 ready
        //                     .clone()
        //                     .map(move |v| {
        //                         v.map(|config| InputConnected {
        //                             id,
        //                             config,
        //                             done_tx,
        //                         })
        //                     })
        //                     .boxed()
        //             },
        //         });

        //         std::thread::spawn({
        //             let config = config.clone();
        //             move || {
        //                 let stream = match device.build_input_stream_raw(
        //                     &config.into(),
        //                     sample_format,
        //                     {
        //                         let actor_ref = actor_ref.clone();
        //                         move |data, info| {
        //                             let _ = actor_ref
        //                                 .tell(MicrophoneSamples {
        //                                     data: data.bytes().to_vec(),
        //                                     format: data.sample_format(),
        //                                     info: info.clone(),
        //                                 })
        //                                 .try_send();
        //                         }
        //                     },
        //                     move |e| {
        //                         error!("Microphone stream error: {e}");

        //                         let _ = error_sender.send(e).is_err();
        //                         actor_ref.kill();
        //                     },
        //                     None,
        //                 ) {
        //                     Ok(stream) => stream,
        //                     Err(e) => {
        //                         let _ = ready_tx.send(Err(SetInputError::BuildStream(e.to_string())));
        //                         return;
        //                     }
        //                 };

        //                 if let Err(e) = stream.play() {
        //                     let _ = ready_tx.send(Err(SetInputError::PlayStream(e.to_string())));
        //                     return;
        //                 }

        //                 let _ = ready_tx.send(Ok(()));

        //                 match done_rx.recv() {
        //                     Ok(_) => {
        //                         info!("Microphone actor shut down, ending stream");
        //                     }
        //                     Err(_) => {
        //                         info!("Microphone actor unreachable, ending stream");
        //                     }
        //                 }
        //             }
        //         });

        //         tokio::spawn({
        //             let ready = ready.clone();
        //             let actor = ctx.actor_ref();
        //             async move {
        //                 match ready.await {
        //                     Ok(config) => {
        //                         let _ = actor
        //                             .tell(InputConnected {
        //                                 id,
        //                                 config,
        //                                 done_tx,
        //                             })
        //                             .await;
        //                     }
        //                     Err(_) => {
        //                         let _ = actor.tell(InputConnectFailed { id }).await;
        //                     }
        //                 }
        //             }
        //         });

        //         Ok(ready.boxed())
    }
}

impl Message<RemoveInput> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        // trace!("CameraFeed.RemoveInput");

        // let state = self.state.try_as_open()?;

        // state.connecting = None;

        // if let Some(AttachedState { done_tx, .. }) = state.attached.take() {
        //     let _ = done_tx.send(());
        // }

        Ok(())
    }
}

impl Message<AddSender> for CameraFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.senders.push(msg.0);
    }
}

// impl Message<MicrophoneSamples> for CameraFeed {
//     type Reply = ();

//     async fn handle(
//         &mut self,
//         msg: MicrophoneSamples,
//         _: &mut Context<Self, Self::Reply>,
//     ) -> Self::Reply {
//         todo!();
//         // let mut to_remove = vec![];

//         // for (i, sender) in self.senders.iter().enumerate() {
//         //     if let Err(TrySendError::Disconnected(_)) = sender.try_send(msg.clone()) {
//         //         warn!("Audio sender {} disconnected, will be removed", i);
//         //         to_remove.push(i);
//         //     };
//         // }

//         // if !to_remove.is_empty() {
//         //     debug!("Removing {} disconnected audio senders", to_remove.len());
//         //     for i in to_remove.into_iter().rev() {
//         //         self.senders.swap_remove(i);
//         //     }
//         // }
//     }
// }

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
        todo!();
        // trace!("CameraFeed.Lock");

        // let state = self.state.try_as_open()?;

        // if let Some(connecting) = &mut state.connecting {
        //     let ready = &mut connecting.ready;
        //     let data = ready.await?;

        //     state.handle_input_connected(data);
        // }

        // let Some(attached) = state.attached.take() else {
        //     return Err(LockFeedError::NoInput);
        // };

        // let config = attached.config.clone();

        // self.state = State::Locked { inner: attached };

        // Ok(CameraFeedLock {
        //     video_info: todo!(),
        //     // audio_info: AudioInfo::from_stream_config(&config),
        //     actor: ctx.actor_ref(),
        //     // config,
        //     lock_tx: ctx.actor_ref().recipient(),
        // })
    }
}

impl Message<InputConnected> for CameraFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("CameraFeed.InputConnected");

        let state = self.state.try_as_open()?;

        state.handle_input_connected(msg);

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

        // let state = self.state.try_as_open()?;

        // if let Some(connecting) = &state.connecting
        //     && connecting.id == msg.id
        // {
        //     state.connecting = None;
        // }

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
