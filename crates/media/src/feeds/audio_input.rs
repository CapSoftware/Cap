use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, InputCallbackInfo, SampleFormat, StreamConfig, SupportedStreamConfig};
use flume::{Receiver, Sender, TrySendError};
use indexmap::IndexMap;
use tracing::warn;

use crate::{
    data::{ffmpeg_sample_format_for, AudioInfo},
    MediaError,
};

#[derive(Clone)]
pub struct AudioInputSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub info: InputCallbackInfo,
}

enum AudioInputControl {
    Switch(String, Sender<Result<SupportedStreamConfig, MediaError>>),
    AttachSender(AudioInputSamplesSender),
    Shutdown,
}

pub struct AudioInputConnection {
    control: Sender<AudioInputControl>,
}

impl AudioInputConnection {
    pub fn attach(&self) -> Receiver<AudioInputSamples> {
        let (sender, receiver) = flume::bounded(5);
        self.control
            .send(AudioInputControl::AttachSender(sender))
            .unwrap();

        receiver
    }
}

pub type AudioInputSamplesSender = Sender<AudioInputSamples>;
pub type AudioInputSamplesReceiver = Receiver<AudioInputSamples>;

pub type AudioInputDeviceMap = IndexMap<String, (Device, SupportedStreamConfig)>;

#[derive(Clone)]
pub struct AudioInputFeed {
    control_tx: Sender<AudioInputControl>,
    audio_info: AudioInfo,
    // rx: Receiver<AudioInputSamples>,
}

impl AudioInputFeed {
    pub fn create_channel() -> (AudioInputSamplesSender, AudioInputSamplesReceiver) {
        flume::bounded(60)
    }

    pub async fn init(selected_input: &str) -> Result<Self, MediaError> {
        let (device, config) = Self::list_devices()
            .swap_remove_entry(selected_input)
            .map(|(device_name, (device, config))| {
                println!("Using audio device: {}", device_name);
                (device, config)
            })
            .unwrap();

        let audio_info = AudioInfo::from_stream_config(&config)?;
        let (control_tx, control_rx) = flume::bounded(1);

        std::thread::spawn(|| start_capturing(device, config, control_rx));

        Ok(Self {
            control_tx,
            audio_info,
            // rx: samples_rx,
        })
    }

    pub fn list_devices() -> AudioInputDeviceMap {
        let host = cpal::default_host();
        let mut device_map = IndexMap::new();

        let get_usable_device = |device: Device| {
            device
                .supported_input_configs()
                .map_err(|error| eprintln!("Error: {error}"))
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
        }

        match host.input_devices() {
            Ok(devices) => {
                for (name, device, config) in devices.filter_map(get_usable_device) {
                    device_map.entry(name).or_insert((device, config));
                }
            }
            Err(error) => {
                eprintln!("Could not access audio input devices");
                eprintln!("{error}");
            }
        }

        device_map
    }

    pub async fn switch_input(&mut self, name: &str) -> Result<(), MediaError> {
        let (tx, rx) = flume::bounded(1);

        self.control_tx
            .send_async(AudioInputControl::Switch(name.to_string(), tx))
            .await
            .map_err(|error| {
                eprintln!("Error while switching audio input: {error}");
                MediaError::TaskLaunch("Failed to switch audio input".into())
            })?;

        let config = rx.recv_async().await.map_err(|error| {
            eprintln!("Error while switching audio input: {error}");
            MediaError::TaskLaunch("Failed to switch audio input".into())
        })??;

        dbg!(&config);

        self.audio_info = AudioInfo::from_stream_config(&config)?;

        Ok(())
    }

    pub async fn add_sender(&self, sender: AudioInputSamplesSender) -> Result<(), MediaError> {
        self.control_tx
            .send_async(AudioInputControl::AttachSender(sender))
            .await
            .map_err(|error| {
                eprintln!("Error while attaching audio input sender: {error}");
                MediaError::TaskLaunch("Failed to attach audio input sender".into())
            })?;

        Ok(())
    }

    pub fn audio_info(&self) -> AudioInfo {
        self.audio_info
    }

    pub fn create_connection(&self) -> AudioInputConnection {
        AudioInputConnection {
            control: self.control_tx.clone(),
        }
    }
}

fn start_capturing(
    mut device: Device,
    mut config: SupportedStreamConfig,
    control: Receiver<AudioInputControl>,
) {
    let mut senders: Vec<AudioInputSamplesSender> = vec![];

    loop {
        let (tx, rx) = flume::bounded(4);

        let stream_config: StreamConfig = config.clone().into();
        let stream = device
            .build_input_stream_raw(
                &stream_config,
                config.sample_format(),
                move |data, info| {
                    tx.send(AudioInputSamples {
                        data: data.bytes().to_vec(),
                        format: data.sample_format(),
                        info: info.clone(),
                    })
                    .ok();
                },
                |_e| {},
                None,
            )
            .map_err(|error| {
                eprintln!("Error while preparing audio capture: {error}");
                MediaError::TaskLaunch("Failed to start audio capture".into())
            });

        loop {
            match control.try_recv() {
                Ok(AudioInputControl::Switch(name, response)) => {
                    // list_devices hangs if the stream isn't dropped
                    drop(stream);
                    let Some(items) = AudioInputFeed::list_devices().swap_remove_entry(&name).map(
                        |(device_name, (device, config))| {
                            println!("Using audio device: {}", device_name);
                            (device, config)
                        },
                    ) else {
                        response
                            .send(Err(MediaError::DeviceUnreachable(name)))
                            .unwrap();
                        break;
                    };

                    device = items.0;
                    config = items.1;

                    response.send(Ok(config.clone())).unwrap();
                    break;
                }
                Ok(AudioInputControl::Shutdown) => {
                    return;
                }
                Ok(AudioInputControl::AttachSender(sender)) => {
                    senders.push(sender);
                }
                Err(flume::TryRecvError::Disconnected) => {
                    println!("Control receiver is unreachable! Shutting down");
                    return;
                }
                Err(flume::TryRecvError::Empty) => {
                    // No signal received, nothing to do
                }
            }

            match rx.recv() {
                Ok(data) => {
                    let mut to_remove = vec![];
                    for (i, sender) in senders.iter().enumerate() {
                        if let Err(TrySendError::Disconnected(_)) = sender.try_send(data.clone()) {
                            to_remove.push(i);
                        };
                    }

                    for i in to_remove.into_iter().rev() {
                        senders.swap_remove(i);
                    }
                }
                Err(error) => {
                    warn!("Failed to capture audio sampels: {:?}", error);
                    // Optionally, add a small delay to avoid busy-waiting
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
            }
        }
    }
}
