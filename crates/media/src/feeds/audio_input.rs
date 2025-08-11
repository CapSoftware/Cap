use cap_fail::fail_err;
use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, InputCallbackInfo, SampleFormat, StreamConfig, SupportedStreamConfig};
use flume::{Receiver, Sender, TrySendError};
use indexmap::IndexMap;
use tracing::{debug, error, info, trace, warn};

use crate::MediaError;

#[derive(Clone)]
pub struct AudioInputSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub info: InputCallbackInfo,
}

pub enum AudioInputControl {
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

pub const MAX_AUDIO_CHANNELS: u16 = 2;

#[derive(Clone)]
pub struct AudioInputFeed {
    pub control_tx: Sender<AudioInputControl>,
    audio_info: AudioInfo,
    // rx: Receiver<AudioInputSamples>,
}

impl AudioInputFeed {
    pub fn create_channel() -> (AudioInputSamplesSender, AudioInputSamplesReceiver) {
        flume::bounded(60)
    }

    pub async fn init(selected_input: &str) -> Result<Self, MediaError> {
        trace!("Initializing audio input feed with device");
        debug!(selected_input);

        fail_err!(
            "media::feeds::audio_input::init",
            MediaError::Any("".into())
        );

        let (device, config) = Self::list_devices()
            .swap_remove_entry(selected_input)
            .map(|(device_name, (device, config))| {
                info!(
                    "Using audio device: {} with config: {:?}",
                    device_name, config
                );
                (device, config)
            })
            .ok_or_else(|| {
                error!("Failed to find audio device: {}", selected_input);
                MediaError::DeviceUnreachable(selected_input.to_string())
            })?;

        let audio_info = AudioInfo::from_stream_config(&config);

        debug!("Created audio info: {:?}", audio_info);
        let (control_tx, control_rx) = flume::bounded(1);

        std::thread::spawn(|| start_capturing(device, config, control_rx));
        info!("Started audio capture thread");

        Ok(Self {
            control_tx,
            audio_info,
        })
    }

    pub fn list_devices() -> AudioInputDeviceMap {
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

    pub async fn switch_input(&mut self, name: &str) -> Result<(), MediaError> {
        fail_err!(
            "media::feeds::audio_input::switch_input",
            MediaError::Any("".into())
        );

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

        self.audio_info = AudioInfo::from_stream_config(&config);

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
    debug!(
        "Starting audio capture with device: {:?}, config: {:?}",
        device.name(),
        config
    );
    let mut senders: Vec<AudioInputSamplesSender> = vec![];

    loop {
        let (tx, rx) = flume::bounded(4);
        debug!("Building input stream with config: {:?}", config);

        let stream_config: StreamConfig = config.clone().into();
        let stream = match device.build_input_stream_raw(
            &stream_config,
            config.sample_format(),
            move |data, info| {
                if let Err(e) = tx.send(AudioInputSamples {
                    data: data.bytes().to_vec(),
                    format: data.sample_format(),
                    info: info.clone(),
                }) {
                    error!("Failed to send audio samples: {}", e);
                }
            },
            |e| {
                error!("Error in audio input stream: {}", e);
            },
            None,
        ) {
            Ok(stream) => {
                info!("Successfully built audio input stream");
                stream
            }
            Err(err) => {
                error!("Failed to build audio input stream: {}", err);
                // Sleep briefly to avoid tight error loop
                std::thread::sleep(std::time::Duration::from_secs(1));
                continue;
            }
        };

        // Try to play the stream
        if let Err(e) = stream.play() {
            error!("Failed to start audio stream playback: {}", e);
            continue;
        }
        info!("Audio stream playback started");

        loop {
            match control.try_recv() {
                Ok(AudioInputControl::Switch(name, response)) => {
                    if device.name().unwrap() == name {
                        response.send(Ok(config.clone())).unwrap();
                        continue;
                    }

                    debug!("Switching audio device to: {}", name);
                    // list_devices hangs if the stream isn't dropped
                    drop(stream);
                    let Some(items) = AudioInputFeed::list_devices().swap_remove_entry(&name).map(
                        |(device_name, (device, config))| {
                            info!(
                                "Switched to audio device: {} with config: {:?}",
                                device_name, config
                            );
                            (device, config)
                        },
                    ) else {
                        error!("Failed to find audio device: {}", name);
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
                    debug!("Received shutdown signal for audio capture");
                    return;
                }
                Ok(AudioInputControl::AttachSender(sender)) => {
                    senders.push(sender);
                    info!("New audio sender attached");
                }
                Err(flume::TryRecvError::Disconnected) => {
                    warn!("Control receiver is unreachable! Shutting down audio capture");
                    return;
                }
                Err(flume::TryRecvError::Empty) => {
                    // No signal received, nothing to do
                }
            }

            match rx.recv() {
                Ok(mut data) => {
                    let mut to_remove = vec![];

                    if config.channels() > MAX_AUDIO_CHANNELS {
                        let mut new_data = Vec::with_capacity(
                            MAX_AUDIO_CHANNELS as usize
                                * (data.data.len() / config.channels() as usize),
                        );

                        let sample_size = data.format.sample_size();

                        for sample in data.data.chunks(sample_size * config.channels() as usize) {
                            new_data.extend_from_slice(
                                &sample[0..sample_size * MAX_AUDIO_CHANNELS as usize],
                            );
                        }

                        data.data = new_data;
                    }

                    for (i, sender) in senders.iter().enumerate() {
                        if let Err(TrySendError::Disconnected(_)) = sender.try_send(data.clone()) {
                            warn!("Audio sender {} disconnected, will be removed", i);
                            to_remove.push(i);
                        };
                    }

                    if !to_remove.is_empty() {
                        debug!("Removing {} disconnected audio senders", to_remove.len());
                        for i in to_remove.into_iter().rev() {
                            senders.swap_remove(i);
                        }
                    }
                }
                Err(error) => {
                    error!("Failed to capture audio samples: {:?}", error);
                    // Break inner loop to recreate the stream
                    break;
                }
            }
        }
    }
}
