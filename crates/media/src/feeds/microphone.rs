use std::sync::mpsc;

use cap_media_info::ffmpeg_sample_format_for;
use cpal::{
    BuildStreamError, Device, InputCallbackInfo, PlayStreamError, SampleFormat, StreamConfig,
    StreamError, SupportedStreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use flume::TrySendError;
use futures::channel::oneshot;
use indexmap::IndexMap;
use kameo::prelude::*;
use tracing::{debug, error, info, trace, warn};

pub type MicrophonesMap = IndexMap<String, (Device, SupportedStreamConfig)>;

#[derive(Clone)]
pub struct AudioInputSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub info: InputCallbackInfo,
}

#[derive(Actor)]
pub struct MicrophoneFeed {
    state: Option<(StreamConfig, mpsc::SyncSender<()>)>,
    senders: Vec<flume::Sender<AudioInputSamples>>,
    error_sender: flume::Sender<StreamError>,
}

impl MicrophoneFeed {
    pub fn new(error_sender: flume::Sender<StreamError>) -> Self {
        Self {
            state: None,
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

pub struct SetInput {
    pub label: String,
}

#[derive(Debug)]
pub enum SetInputError {
    DeviceNotFound,
    BuildStreamCrashed,
    BuildStream(BuildStreamError),
    PlayStream(PlayStreamError),
}

impl Message<SetInput> for MicrophoneFeed {
    type Reply = Result<StreamConfig, SetInputError>;

    async fn handle(&mut self, msg: SetInput, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.SetInput('{}')", &msg.label);

        let Some((device, config)) = Self::list().swap_remove(&msg.label) else {
            return Err(SetInputError::DeviceNotFound);
        };

        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();

        let (ready_tx, ready_rx) = oneshot::channel();
        let (done_tx, done_rx) = mpsc::sync_channel(0);

        let _stream_config = stream_config.clone();
        let actor_ref = ctx.actor_ref();
        let error_sender = self.error_sender.clone();

        std::thread::spawn(move || {
            let stream = match device.build_input_stream_raw(
                &_stream_config,
                sample_format,
                {
                    let actor_ref = actor_ref.clone();
                    move |data, info| {
                        let _ = actor_ref
                            .tell(AudioInputSamples {
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
                    let _ = ready_tx.send(Err(SetInputError::BuildStream(e)));
                    return;
                }
            };

            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(SetInputError::PlayStream(e)));
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

        ready_rx
            .await
            .map_err(|_| SetInputError::BuildStreamCrashed)??;

        self.state = Some((stream_config.clone(), done_tx));

        Ok(stream_config)
    }
}

pub struct AddSender(pub flume::Sender<AudioInputSamples>);

impl Message<AddSender> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.senders.push(msg.0);
    }
}

impl Message<AudioInputSamples> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: AudioInputSamples,
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
