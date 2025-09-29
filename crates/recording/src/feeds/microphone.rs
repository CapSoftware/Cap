use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cap_timestamp::Timestamp;
use cpal::{
    Device, InputCallbackInfo, SampleFormat, StreamError, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use flume::TrySendError;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use indexmap::IndexMap;
use kameo::prelude::*;
use replace_with::replace_with_or_abort;
use std::{
    ops::Deref,
    sync::{
        Arc,
        mpsc::{self, SyncSender},
    },
};
use tracing::{debug, error, info, trace, warn};

use crate::output_pipeline::{AudioFrame, AudioSource};

pub type MicrophonesMap = IndexMap<String, (Device, SupportedStreamConfig)>;

#[derive(Clone)]
pub struct MicrophoneSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub info: InputCallbackInfo,
    pub timestamp: Timestamp,
}

#[derive(Actor)]
pub struct MicrophoneFeed {
    input_id_counter: u32,
    state: State,
    senders: Vec<flume::Sender<MicrophoneSamples>>,
    error_sender: flume::Sender<StreamError>,
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
        if let Some(connecting) = &self.connecting
            && data.id == connecting.id
        {
            self.attached = Some(AttachedState {
                id: data.id,
                config: data.config.clone(),
                done_tx: data.done_tx,
            });
            self.connecting = None;
        }
    }
}

struct ConnectingState {
    id: u32,
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
}

struct AttachedState {
    #[allow(dead_code)]
    id: u32,
    config: SupportedStreamConfig,
    done_tx: mpsc::SyncSender<()>,
}

impl MicrophoneFeed {
    pub fn new(error_sender: flume::Sender<StreamError>) -> Self {
        Self {
            input_id_counter: 0,
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
            error_sender,
        }
    }

    pub fn default() -> Option<(String, Device, SupportedStreamConfig)> {
        let host = cpal::default_host();
        host.default_input_device().and_then(get_usable_device)
    }

    pub fn list() -> MicrophonesMap {
        let host = cpal::default_host();
        let mut device_map = IndexMap::new();

        if let Some((name, device, config)) =
            host.default_input_device().and_then(get_usable_device)
        {
            device_map.insert(name, (device, config));
        } else {
            warn!("No default input device found or it's not usable");
        }

        match host.input_devices() {
            Ok(devices) => {
                for (name, device, config) in devices.filter_map(get_usable_device) {
                    device_map.entry(name).or_insert((device, config));
                }
            }
            Err(error) => {
                error!("Could not access audio input devices: {}", error);
            }
        }

        device_map
    }
}

fn get_usable_device(device: Device) -> Option<(String, Device, SupportedStreamConfig)> {
    device
        .supported_input_configs()
        .map_err(|error| {
            error!(
                "Error getting supported input configs for device: {}",
                error
            );
            error
        })
        .ok()
        .and_then(|configs| {
            let mut configs = configs.collect::<Vec<_>>();
            configs.sort_by(|a, b| {
                b.sample_format()
                    .sample_size()
                    .cmp(&a.sample_format().sample_size())
                    .then(b.max_sample_rate().cmp(&a.max_sample_rate()))
            });
            configs
                .into_iter()
                .filter(|c| c.min_sample_rate().0 <= 48000 && c.max_sample_rate().0 <= 48000)
                .find(|c| ffmpeg_sample_format_for(c.sample_format()).is_some())
        })
        .and_then(|config| {
            device
                .name()
                .ok()
                .map(|name| (name, device, config.with_max_sample_rate()))
        })
}

#[derive(Reply)]
pub struct MicrophoneFeedLock {
    actor: ActorRef<MicrophoneFeed>,
    config: SupportedStreamConfig,
    audio_info: AudioInfo,
    drop_tx: Option<oneshot::Sender<()>>,
}

impl MicrophoneFeedLock {
    pub fn config(&self) -> &SupportedStreamConfig {
        &self.config
    }

    pub fn audio_info(&self) -> AudioInfo {
        self.audio_info
    }
}

impl Deref for MicrophoneFeedLock {
    type Target = ActorRef<MicrophoneFeed>;

    fn deref(&self) -> &Self::Target {
        &self.actor
    }
}

impl Drop for MicrophoneFeedLock {
    fn drop(&mut self) {
        if let Some(drop_tx) = self.drop_tx.take() {
            let _ = drop_tx.send(());
        }
    }
}

// Public Requests

pub struct SetInput {
    pub label: String,
}

pub struct RemoveInput;

pub struct AddSender(pub flume::Sender<MicrophoneSamples>);

pub struct Lock;

// Private Events

struct InputConnected {
    id: u32,
    config: SupportedStreamConfig,
    done_tx: SyncSender<()>,
}

struct InputConnectFailed {
    id: u32,
}

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
    BuildStreamCrashed,
    // we use strings for these as the cpal errors aren't Clone
    #[error("BuildStream: {0}")]
    BuildStream(String),
    #[error("PlayStream: {0}")]
    PlayStream(String),
}

impl Message<SetInput> for MicrophoneFeed {
    type Reply =
        Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>;

    async fn handle(&mut self, msg: SetInput, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.SetInput('{}')", &msg.label);

        let state = self.state.try_as_open()?;

        let id = self.input_id_counter;
        self.input_id_counter += 1;

        let Some((device, config)) = Self::list().swap_remove(&msg.label) else {
            return Err(SetInputError::DeviceNotFound);
        };

        let sample_format = config.sample_format();

        let (ready_tx, ready_rx) = oneshot::channel();
        let (done_tx, done_rx) = mpsc::sync_channel(0);

        let actor_ref = ctx.actor_ref();
        let ready = {
            let config = config.clone();
            ready_rx
                .map(|v| {
                    v.map_err(|_| SetInputError::BuildStreamCrashed)
                        .map(|_| config)
                })
                .shared()
        };
        let error_sender = self.error_sender.clone();

        state.connecting = Some(ConnectingState {
            id,
            ready: {
                let done_tx = done_tx.clone();
                ready
                    .clone()
                    .map(move |v| {
                        v.map(|config| InputConnected {
                            id,
                            config,
                            done_tx,
                        })
                    })
                    .boxed()
            },
        });

        std::thread::spawn({
            let config = config.clone();
            move || {
                let stream = match device.build_input_stream_raw(
                    &config.into(),
                    sample_format,
                    {
                        let actor_ref = actor_ref.clone();
                        move |data, info| {
                            let _ = actor_ref
                                .tell(MicrophoneSamples {
                                    data: data.bytes().to_vec(),
                                    format: data.sample_format(),
                                    info: info.clone(),
                                    timestamp: Timestamp::from_cpal(info.timestamp().capture),
                                })
                                .try_send();
                        }
                    },
                    move |e| {
                        error!("Microphone stream error: {e}");

                        let _ = error_sender.send(e).is_err();
                        actor_ref.kill();
                    },
                    None,
                ) {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = ready_tx.send(Err(SetInputError::BuildStream(e.to_string())));
                        return;
                    }
                };

                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(SetInputError::PlayStream(e.to_string())));
                    return;
                }

                let _ = ready_tx.send(Ok(()));

                match done_rx.recv() {
                    Ok(_) => {
                        info!("Microphone actor shut down, ending stream");
                    }
                    Err(_) => {
                        info!("Microphone actor unreachable, ending stream");
                    }
                }
            }
        });

        tokio::spawn({
            let ready = ready.clone();
            let actor = ctx.actor_ref();
            async move {
                match ready.await {
                    Ok(config) => {
                        let _ = actor
                            .tell(InputConnected {
                                id,
                                config,
                                done_tx,
                            })
                            .await;
                    }
                    Err(_) => {
                        let _ = actor.tell(InputConnectFailed { id }).await;
                    }
                }
            }
        });

        Ok(ready.boxed())
    }
}

impl Message<RemoveInput> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.RemoveInput");

        let state = self.state.try_as_open()?;

        state.connecting = None;

        if let Some(AttachedState { done_tx, .. }) = state.attached.take() {
            let _ = done_tx.send(());
        }

        Ok(())
    }
}

impl Message<AddSender> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.senders.push(msg.0);
    }
}

impl Message<MicrophoneSamples> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: MicrophoneSamples,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let mut to_remove = vec![];

        for (i, sender) in self.senders.iter().enumerate() {
            if let Err(TrySendError::Disconnected(_)) = sender.try_send(msg.clone()) {
                warn!("Audio sender {} disconnected, will be removed", i);
                to_remove.push(i);
            };
        }

        if !to_remove.is_empty() {
            debug!("Removing {} disconnected audio senders", to_remove.len());
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

impl Message<Lock> for MicrophoneFeed {
    type Reply = Result<MicrophoneFeedLock, LockFeedError>;

    async fn handle(&mut self, _: Lock, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.Lock");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &mut state.connecting {
            let ready = &mut connecting.ready;
            let data = ready.await?;

            state.handle_input_connected(data);
        }

        let Some(attached) = state.attached.take() else {
            return Err(LockFeedError::NoInput);
        };

        let config = attached.config.clone();

        self.state = State::Locked { inner: attached };

        let (drop_tx, drop_rx) = oneshot::channel();

        let actor_ref = ctx.actor_ref();
        tokio::spawn(async move {
            let _ = drop_rx.await;
            let _ = actor_ref.tell(Unlock).await;
        });

        Ok(MicrophoneFeedLock {
            audio_info: AudioInfo::from_stream_config(&config),
            actor: ctx.actor_ref(),
            config,
            drop_tx: Some(drop_tx),
        })
    }
}

impl Message<InputConnected> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnected");

        let state = self.state.try_as_open()?;

        state.handle_input_connected(msg);

        Ok(())
    }
}

impl Message<InputConnectFailed> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnectFailed");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &state.connecting
            && connecting.id == msg.id
        {
            state.connecting = None;
        }

        Ok(())
    }
}

impl Message<Unlock> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, _: Unlock, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.Unlock");

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
