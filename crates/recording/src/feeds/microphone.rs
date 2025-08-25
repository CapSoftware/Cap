use std::{
    ops::Deref,
    sync::mpsc::{self, SyncSender},
};

use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cpal::{
    Device, InputCallbackInfo, SampleFormat, StreamError, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use flume::TrySendError;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use indexmap::IndexMap;
use kameo::prelude::*;
use tracing::{debug, error, info, trace, warn};

pub type MicrophonesMap = IndexMap<String, (Device, SupportedStreamConfig)>;

#[derive(Clone)]
pub struct MicrophoneSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub info: InputCallbackInfo,
}

#[derive(Actor)]
pub struct MicrophoneFeed {
    input_id_counter: u32,
    state: State,
    senders: Vec<flume::Sender<MicrophoneSamples>>,
    error_sender: flume::Sender<StreamError>,
}

enum State {
    Detached,
    Initializing {
        id: u32,
        ready: BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>,
    },
    Attached {
        id: u32,
        config: SupportedStreamConfig,
        done_tx: mpsc::SyncSender<()>,
    },
}

impl MicrophoneFeed {
    pub fn new(error_sender: flume::Sender<StreamError>) -> Self {
        Self {
            input_id_counter: 0,
            state: State::Detached,
            senders: Vec::new(),
            error_sender,
        }
    }

    pub fn list() -> MicrophonesMap {
        let host = cpal::default_host();
        let mut device_map = IndexMap::new();

        let get_usable_device = |device: Device| {
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
                        .filter(|c| {
                            c.min_sample_rate().0 <= 48000 && c.max_sample_rate().0 <= 48000
                        })
                        .find(|c| ffmpeg_sample_format_for(c.sample_format()).is_some())
                })
                .and_then(|config| {
                    device
                        .name()
                        .ok()
                        .map(|name| (name, device, config.with_max_sample_rate()))
                })
        };

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

#[derive(Reply)]
pub struct MicrophoneFeedLock {
    actor: ActorRef<MicrophoneFeed>,
    config: SupportedStreamConfig,
    audio_info: AudioInfo,
}

impl MicrophoneFeedLock {
    pub fn config(&self) -> &SupportedStreamConfig {
        &self.config
    }

    pub fn audio_info(&self) -> &AudioInfo {
        &self.audio_info
    }
}

impl Deref for MicrophoneFeedLock {
    type Target = ActorRef<MicrophoneFeed>;

    fn deref(&self) -> &Self::Target {
        &self.actor
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

// Impls

#[derive(Clone, Debug, thiserror::Error)]
pub enum SetInputError {
    #[error("DeviceNotFound")]
    DeviceNotFound,
    #[error("BuildStreamCrashed")]
    BuildStreamCrashed,
    // we use stringes for these as the cpal errors aren't Clone
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

        let id = self.input_id_counter;
        self.input_id_counter += 1;

        let Some((device, config)) = Self::list().swap_remove(&msg.label) else {
            return Err(SetInputError::DeviceNotFound);
        };

        let sample_format = config.sample_format();

        let (ready_tx, ready_rx) = oneshot::channel();
        let (done_tx, done_rx) = mpsc::sync_channel(0);

        let _stream_config = config.clone().into();
        let actor_ref = ctx.actor_ref();
        let ready = ready_rx
            .map(|v| {
                v.map_err(|_| SetInputError::BuildStreamCrashed)
                    .map(|_| config)
            })
            .shared();
        let error_sender = self.error_sender.clone();

        self.state = State::Initializing {
            id,
            ready: ready.clone().boxed(),
        };

        std::thread::spawn(move || {
            let stream = match device.build_input_stream_raw(
                &_stream_config,
                sample_format,
                {
                    let actor_ref = actor_ref.clone();
                    move |data, info| {
                        let _ = actor_ref
                            .tell(MicrophoneSamples {
                                data: data.bytes().to_vec(),
                                format: data.sample_format(),
                                info: info.clone(),
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
    type Reply = ();

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.RemoveInput");

        match std::mem::replace(&mut self.state, State::Detached) {
            State::Detached => {}
            State::Initializing { .. } => {}
            State::Attached { done_tx, .. } => {
                let _ = done_tx.send(());
            }
        }
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
    #[error("NoInput")]
    NoInput,
    #[error("InitializeFailed${0}")]
    InitializeFailed(SetInputError),
}

impl Message<Lock> for MicrophoneFeed {
    type Reply = Result<MicrophoneFeedLock, LockFeedError>;

    async fn handle(&mut self, _: Lock, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let config = match &mut self.state {
            State::Detached => return Err(LockFeedError::NoInput),
            State::Initializing { ready, .. } => {
                ready.await.map_err(LockFeedError::InitializeFailed)?
            }
            State::Attached { config, .. } => config.clone(),
        };

        Ok(MicrophoneFeedLock {
            audio_info: AudioInfo::from_stream_config(&config),
            actor: ctx.actor_ref(),
            config,
        })
    }
}

impl Message<InputConnected> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if let State::Initializing { id, .. } = self.state
            && id == msg.id
        {
            self.state = State::Attached {
                id: msg.id,
                config: msg.config,
                done_tx: msg.done_tx,
            };
        }
    }
}

impl Message<InputConnectFailed> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if let State::Attached { id, .. } = self.state
            && id == msg.id
        {
            self.state = State::Detached;
        }
    }
}
