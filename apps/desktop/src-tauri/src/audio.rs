use cap_ffmpeg::NamedPipeCapture;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SizedSample, Stream, StreamConfig, SupportedStreamConfig};
use indexmap::IndexMap;
use num_traits::ToBytes;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::time::Instant;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{oneshot, watch};

type SampleReceiver = mpsc::Receiver<Arc<Vec<u8>>>;

pub struct AudioCapturer {
    device: Device,
    pub device_name: String,
    pub supported_config: SupportedStreamConfig,
    pub config: StreamConfig,
    sample_receiver: Option<SampleReceiver>,
    stream: Option<Stream>,
}
unsafe impl Send for AudioCapturer {}
unsafe impl Sync for AudioCapturer {}

const MAX_CHANNELS: u16 = 2;

impl AudioCapturer {
    pub fn init(name: &str) -> Option<Self> {
        println!("Custom device: {}", name);

        get_input_devices()
            .swap_remove(name)
            .map(|(device, supported_config)| {
                println!("Using audio device: {}", name);

                let mut config = supported_config.config();

                config.channels = config.channels.min(MAX_CHANNELS);

                Self {
                    config,
                    supported_config,
                    device,
                    device_name: name.to_string(),
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

    pub fn start(&mut self, start_time_tx: oneshot::Sender<Instant>) -> Result<(), String> {
        tracing::trace!("Building input stream...");

        let (receiver, stream) = (match self.supported_config.sample_format() {
            SampleFormat::I8 => self.build_stream::<i8>(start_time_tx),
            SampleFormat::I16 => self.build_stream::<i16>(start_time_tx),
            SampleFormat::I32 => self.build_stream::<i32>(start_time_tx),
            SampleFormat::U8 => self.build_stream::<u8>(start_time_tx),
            SampleFormat::U16 => self.build_stream::<u16>(start_time_tx),
            SampleFormat::U32 => self.build_stream::<u32>(start_time_tx),
            SampleFormat::F32 => self.build_stream::<f32>(start_time_tx),
            SampleFormat::F64 => self.build_stream::<f64>(start_time_tx),
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

    pub fn pause(&mut self) -> Result<(), String> {
        if let Some(ref mut stream) = self.stream {
            stream
                .pause()
                .map_err(|_| "Failed to pause stream".to_string())
        } else {
            Err("Stream not started".to_string())
        }
    }

    pub fn resume(&mut self) -> Result<(), String> {
        if let Some(ref mut stream) = self.stream {
            stream
                .play()
                .map_err(|_| "Failed to resume stream".to_string())
        } else {
            Err("Stream not started".to_string())
        }
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(ref mut stream) = self.stream {
            stream.pause().map_err(|_| "Failed to pause stream")?;
            tracing::info!("Audio capturing stopped.");
            Ok(())
        } else {
            Err("Original recording was not started".to_string())
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
        self.config.sample_rate.0
    }

    pub fn channels(&self) -> u16 {
        self.config.channels
    }

    // Returns ffmpeg sample format ID and sample size in bytes
    pub fn sample_format(&self) -> &str {
        match self.supported_config.sample_format() {
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

    fn build_stream<T>(
        &self,
        start_time_tx: oneshot::Sender<Instant>,
    ) -> Result<(SampleReceiver, Stream), String>
    where
        T: SizedSample + ToBytes<Bytes: AsRef<[u8]>>,
    {
        let (sender, receiver) = mpsc::channel(2048);

        let mut start_time_tx = Some(start_time_tx);

        self.device
            .build_input_stream(
                &self.config.clone(),
                move |data: &[T], _| {
                    let sample_size = std::mem::size_of::<T>();
                    let mut bytes = vec![0; std::mem::size_of_val(data)];
                    let size = bytes.len();
                    for (dest, source) in bytes.chunks_exact_mut(sample_size).zip(data.iter()) {
                        dest.copy_from_slice(source.to_le_bytes().as_ref());
                    }

                    let sample_data = Arc::new(bytes);
                    match sender.try_send(sample_data) {
                        Ok(_) => {
                            if let Some(start_time_option) = start_time_tx.take() {
                                start_time_option.send(Instant::now()).ok();

                                tracing::info!("Audio sample size: {size}");
                                tracing::trace!("Audio start time captured");
                            }
                        }
                        Err(TrySendError::Full(_)) => {
                            // TODO: Consider panicking? This should *never* happen
                            tracing::error!("Channel buffer is full!");
                        }
                        _ => {
                            tracing::trace!("Recording has been stopped. Dropping data.")
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
            // .map_err(utils::log_debug_error)
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

pub async fn start_capturing(
    capturer: &mut AudioCapturer,
    pipe_path: PathBuf,
    start_writing_rx: watch::Receiver<bool>,
) -> (NamedPipeCapture, Instant) {
    let (capture, is_stopped, is_paused) = NamedPipeCapture::new(&pipe_path);

    let (tx, rx) = oneshot::channel();

    capturer.start(tx).unwrap();

    println!("Starting audio channel senders...");
    let mut receiver = capturer
        .sample_receiver
        .take()
        .expect("Audio sample collection already started!");

    tokio::spawn(async move {
        println!("Opening audio pipe...");
        let mut pipe = File::create(&pipe_path).unwrap();
        println!("Audio pipe opened");

        while let Some(bytes) = receiver.recv().await {
            if is_stopped.load(Ordering::Relaxed) {
                println!("Stopping receiving audio frames");
                return;
            }

            if !*start_writing_rx.borrow() {
                continue;
            }

            if is_paused.load(Ordering::Relaxed) {
                // Skip writing data to pipe while paused
                continue;
            }

            pipe.write_all(&bytes).unwrap();
        }

        println!("Done receiving audio frames");

        pipe.sync_all().ok();
    });

    (capture, rx.await.unwrap())
}

pub fn play_audio<const N: usize>(bytes: &'static [u8; N]) {
    use rodio::{Decoder, OutputStream, Sink};
    use std::io::Cursor;

    if let Ok((_, stream)) = OutputStream::try_default() {
        let file = Cursor::new(bytes);
        let source = Decoder::new(file).unwrap();
        let sink = Sink::try_new(&stream).unwrap();
        sink.append(source);
        sink.sleep_until_end();
    }
}
