use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, InputCallbackInfo, SampleFormat, StreamConfig, SupportedStreamConfig};
use flume::{Receiver, Sender, TrySendError};
use indexmap::IndexMap;
use std::sync::{Arc, Mutex};
use tracing::warn;

use crate::{
    data::{ffmpeg_sample_format_for, AudioInfo, FFAudio},
    MediaError, TARGET_SAMPLE_RATE,
};
use ffmpeg::format::sample::{Sample, Type};
use ffmpeg::software::resampling;

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
        let (device, mut config) = Self::list_devices()
            .swap_remove_entry(selected_input)
            .map(|(device_name, (device, config))| {
                println!("Using audio device: {}", device_name);
                (device, config)
            })
            .unwrap();

        // Check if we need to downsample
        let original_sample_rate = config.sample_rate().0;
        if original_sample_rate > TARGET_SAMPLE_RATE {
            println!(
                "Downsampling audio from {}Hz to {}Hz",
                original_sample_rate, TARGET_SAMPLE_RATE
            );

            // Get the supported config range and create a new config with our target rate
            let supported_config = device
                .supported_input_configs()
                .expect("Failed to get supported configs")
                .find(|range| {
                    range.channels() == config.channels()
                        && range.sample_format() == config.sample_format()
                        && range.min_sample_rate().0 <= TARGET_SAMPLE_RATE
                        && range.max_sample_rate().0 >= TARGET_SAMPLE_RATE
                })
                .expect("No supported config found for target sample rate");

            // Create a new config with the target sample rate
            config = supported_config.with_sample_rate(cpal::SampleRate(TARGET_SAMPLE_RATE));
        }

        let stream_config: cpal::StreamConfig = config.clone().into();
        let audio_info = AudioInfo::from_stream_config(&config);

        // Create resampler if needed
        let resampler = if original_sample_rate != TARGET_SAMPLE_RATE {
            Some(Arc::new(Mutex::new(
                InputResampler::new(
                    config.sample_format(),
                    original_sample_rate,
                    config.channels(),
                )
                .expect("Failed to create resampler"),
            )))
        } else {
            None
        };

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

struct InputResampler {
    context: resampling::Context,
    output_frame: FFAudio,
    input_info: AudioInfo,
    output_info: AudioInfo,
}

impl InputResampler {
    fn new(input_format: SampleFormat, input_rate: u32, channels: u16) -> Result<Self, MediaError> {
        let input_info = AudioInfo::new(
            ffmpeg_sample_format_for(input_format).unwrap(),
            input_rate,
            channels,
        );

        let output_info = AudioInfo::new(Sample::F32(Type::Planar), TARGET_SAMPLE_RATE, channels);

        println!(
            "Setting up resampler: {}Hz -> {}Hz, format: {:?} -> f32, channels: {}",
            input_rate, TARGET_SAMPLE_RATE, input_format, channels
        );

        // Create resampling context with proper configuration
        let context = ffmpeg::software::resampler(
            (
                input_info.sample_format,
                input_info.channel_layout(),
                input_info.sample_rate,
            ),
            (
                output_info.sample_format,
                output_info.channel_layout(),
                output_info.sample_rate,
            ),
        )?;

        Ok(Self {
            context,
            output_frame: FFAudio::empty(),
            input_info,
            output_info,
        })
    }

    fn resample(&mut self, samples: AudioInputSamples) -> AudioInputSamples {
        if self.input_info.sample_rate == TARGET_SAMPLE_RATE {
            return samples;
        }

        // Calculate number of samples in input
        let samples_per_channel =
            samples.data.len() / (self.input_info.channels * self.input_info.sample_format.bytes());

        // Create input frame with proper configuration
        let mut input_frame = FFAudio::new(
            self.input_info.sample_format,
            samples_per_channel,
            self.input_info.channel_layout(),
        );
        input_frame.set_rate(self.input_info.sample_rate);
        input_frame.set_samples(samples_per_channel);
        input_frame.data_mut(0)[..samples.data.len()].copy_from_slice(&samples.data);

        // Reset output frame
        self.output_frame = FFAudio::new(
            self.output_info.sample_format,
            samples_per_channel, // Initial size, will be adjusted by resampler
            self.output_info.channel_layout(),
        );
        self.output_frame.set_rate(TARGET_SAMPLE_RATE);

        // Perform resampling
        self.context
            .run(&input_frame, &mut self.output_frame)
            .expect("Resampling failed");

        // Calculate output size and copy data
        let output_samples = self.output_frame.samples();
        let output_len =
            output_samples * self.output_info.channels * self.output_info.sample_format.bytes();

        let mut resampled_data = vec![0u8; output_len];
        resampled_data[..output_len].copy_from_slice(&self.output_frame.data(0)[..output_len]);

        AudioInputSamples {
            data: resampled_data,
            format: SampleFormat::F32, // Update format to match our resampled data
            info: samples.info,
        }
    }
}

fn start_capturing(
    mut device: Device,
    mut config: SupportedStreamConfig,
    control: Receiver<AudioInputControl>,
) {
    let mut senders: Vec<AudioInputSamplesSender> = vec![];
    let original_sample_rate = device
        .default_input_config()
        .map(|c| c.sample_rate().0)
        .unwrap_or(config.sample_rate().0);

    let needs_resampling = original_sample_rate > TARGET_SAMPLE_RATE;
    let resampler = if needs_resampling {
        Some(Arc::new(Mutex::new(
            InputResampler::new(
                config.sample_format(),
                original_sample_rate,
                config.channels(),
            )
            .expect("Failed to create resampler"),
        )))
    } else {
        None
    };

    loop {
        let (tx, rx) = flume::bounded(4);
        let resampler = resampler.clone();

        let stream_config: StreamConfig = config.clone().into();
        let stream = device
            .build_input_stream_raw(
                &stream_config,
                config.sample_format(),
                move |data, info| {
                    let mut audio_samples = AudioInputSamples {
                        data: data.bytes().to_vec(),
                        format: data.sample_format(),
                        info: info.clone(),
                    };

                    if let Some(resampler) = &resampler {
                        if let Ok(mut resampler) = resampler.lock() {
                            audio_samples = resampler.resample(audio_samples);
                        }
                    }

                    tx.send(audio_samples).ok();
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
