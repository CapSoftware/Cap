use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SizedSample, Stream, SupportedStreamConfig};
use indexmap::IndexMap;
use num_traits::ToBytes;
use std::{future::Future, path::PathBuf};
use tokio::sync::mpsc::error::TrySendError;
use tokio::{fs::File, io::AsyncWriteExt, sync::mpsc};

use super::{Instant, SharedFlag, SharedInstant};
use crate::utils;

type SampleReceiver = mpsc::Receiver<Vec<u8>>;

pub struct AudioCapturer {
    device: Device,
    pub device_name: String,
    config: SupportedStreamConfig,
    should_stop: SharedFlag,
    sample_receiver: Option<SampleReceiver>,
    stream: Option<Stream>,
}

impl AudioCapturer {
    pub fn init(custom_device: Option<&str>, should_stop: SharedFlag) -> Option<Self> {
        tracing::debug!("Custom device: {:?}", custom_device);

        if custom_device == Some("None") {
            return None;
        }

        let mut devices = get_input_devices();

        let maybe_device = match custom_device {
            None => {
                let maybe_name = devices.first().map(|(name, _)| name.clone());
                maybe_name.and_then(|device_name| devices.swap_remove_entry(&device_name))
            }
            Some(device_name) => devices.swap_remove_entry(device_name),
        };

        maybe_device.map(|(name, (device, config))| {
            tracing::info!("Using audio device: {}", name);

            Self {
                config,
                device,
                device_name: name,
                should_stop,
                sample_receiver: None,
                stream: None,
            }
        })
    }

    pub fn log_info(&self) {
        tracing::info!("Sample rate: {}", self.sample_rate());
        tracing::info!("Channels: {}", self.channels());
        tracing::info!("Sample format: {}", self.sample_format());
    }

    pub fn start(&mut self, start_time: SharedInstant) -> Result<(), String> {
        tracing::trace!("Building input stream...");

        let (receiver, stream) = (match self.config.sample_format() {
            SampleFormat::I8 => self.build_stream::<i8>(start_time),
            SampleFormat::I16 => self.build_stream::<i16>(start_time),
            SampleFormat::I32 => self.build_stream::<i32>(start_time),
            SampleFormat::U8 => self.build_stream::<u8>(start_time),
            SampleFormat::U16 => self.build_stream::<u16>(start_time),
            SampleFormat::U32 => self.build_stream::<u32>(start_time),
            SampleFormat::F32 => self.build_stream::<f32>(start_time),
            SampleFormat::F64 => self.build_stream::<f64>(start_time),
            _ => unreachable!(),
        })?;

        stream
            .play()
            .map_err(|_| "Failed to start audio recording")?;
        tracing::info!("Audio recording started.");

        self.stream = Some(stream);
        self.sample_receiver = Some(receiver);
        Ok(())
    }

    pub fn collect_samples(&mut self, destination: PathBuf) -> impl Future<Output = ()> + 'static {
        tracing::trace!("Starting audio channel senders...");
        let mut receiver = self
            .sample_receiver
            .take()
            .expect("Audio sample collection already started!");
        let should_stop = self.should_stop.clone();

        async move {
            let mut pipe = File::create(destination).await.unwrap();

            while let Some(bytes) = receiver.recv().await {
                pipe.write_all(&bytes)
                    .await
                    .expect("Failed to write audio data to FFmpeg stdin");

                if should_stop.get() {
                    receiver.close();
                }
            }
        }
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(ref mut stream) = self.stream {
            stream.pause().map_err(|_| "Failed to pause stream")?;
            tracing::info!("Audio capturing stopped.");
            Ok(())
        } else {
            return Err("Original recording was not started".to_string());
        }
    }

    // TODO: Where to add these...?
    pub fn ffmpeg_filters(&self) -> Vec<&str> {
        let mut audio_filters = Vec::new();

        if self.channels() > 2 {
            audio_filters.push("pan=stereo|FL=FL+0.5*FC|FR=FR+0.5*FC");
        }

        audio_filters.push("loudnorm");
        audio_filters
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate().0
    }

    pub fn channels(&self) -> u16 {
        self.config.channels()
    }

    // Returns ffmpeg sample format ID and sample size in bytes
    pub fn sample_format(&self) -> &str {
        match self.config.sample_format() {
            SampleFormat::I8 => "s8",
            SampleFormat::I16 => "s16le",
            SampleFormat::I32 => "s32le",
            SampleFormat::U8 => "u8",
            SampleFormat::U16 => "u16le",
            SampleFormat::U32 => "u32le",
            SampleFormat::F32 => "f32le",
            SampleFormat::F64 => "f64le",
            _ => unreachable!(),
        }
    }

    fn build_stream<T>(&self, start_time: SharedInstant) -> Result<(SampleReceiver, Stream), String>
    where
        T: SizedSample + ToBytes<Bytes: AsRef<[u8]>>,
    {
        let (sender, receiver) = mpsc::channel(2048);

        self.device
            .build_input_stream(
                &self.config.clone().into(),
                move |data: &[T], _| {
                    let mut first_frame_time_guard = start_time.try_lock();

                    let sample_size = std::mem::size_of::<T>();
                    let mut bytes = vec![0; data.len() * sample_size];
                    for (dest, source) in bytes.chunks_exact_mut(sample_size).zip(data.iter()) {
                        dest.copy_from_slice(source.to_le_bytes().as_ref());
                    }

                    match sender.try_send(bytes) {
                        Ok(_) => {
                            if let Ok(ref mut start_time_option) = first_frame_time_guard {
                                if start_time_option.is_none() {
                                    **start_time_option = Some(Instant::now());

                                    tracing::trace!("Audio start time captured");
                                }
                            }
                        }
                        Err(TrySendError::Full(_)) => {
                            // TODO: Consider panicking? This should *never* happen
                            tracing::error!("Channel buffer is full!");
                        }
                        _ => {
                            tracing::info!("Recording has been stopped. Dropping data.")
                        }
                    }
                },
                |err| {
                    tracing::error!("An error occurred on the audio stream: {}", err);
                },
                None,
            )
            .map(|stream| (receiver, stream))
            .map_err(|_| "Failed to build audio input stream".into())
    }
}

pub fn get_input_devices() -> IndexMap<String, (Device, SupportedStreamConfig)> {
    let host = cpal::default_host();
    let mut device_map = IndexMap::new();

    let get_usable_device = |device: Device| {
        device
            .supported_input_configs()
            .map_err(utils::log_debug_error)
            .ok()
            .and_then(|mut configs| {
                configs.find(|c| match c.sample_format() {
                    SampleFormat::I8
                    | SampleFormat::I16
                    | SampleFormat::I32
                    | SampleFormat::U8
                    | SampleFormat::U16
                    | SampleFormat::U32
                    | SampleFormat::F32
                    | SampleFormat::F64 => true,
                    _ => false,
                })
            })
            .and_then(|config| {
                device
                    .name()
                    .ok()
                    .map(|name| (name, device, config.with_max_sample_rate()))
            })
    };

    if let Some((name, device, config)) = host.default_input_device().and_then(get_usable_device) {
        device_map.insert(name, (device, config));
    }

    match host.input_devices() {
        Ok(devices) => {
            for (name, device, config) in devices.filter_map(get_usable_device) {
                device_map.entry(name).or_insert((device, config));
            }
        }
        Err(error) => {
            tracing::warn!("Could not access audio input devices");
            tracing::debug!("{error}");
        }
    }

    device_map
}
