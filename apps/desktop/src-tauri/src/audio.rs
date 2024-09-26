use cap_utils::create_named_pipe;
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, SizedSample, Stream, StreamConfig, SupportedStreamConfig,
};
use ffmpeg_next as ffmpeg;
use indexmap::IndexMap;
use num_traits::ToBytes;
use std::{fs::File, io::Write, path::PathBuf, sync::Arc, time::Instant};
use tokio::sync::{
    mpsc::{self, error::TrySendError},
    oneshot, watch,
};

use crate::{capture::CaptureController, encoder::MP3Encoder};

type SampleReceiver = mpsc::Receiver<Arc<Vec<f32>>>;

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

const MAX_CHANNELS: u16 = 1;

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
        println!("Sample rate: {}", self.sample_rate());
        println!("Channels: {}", self.channels());
        println!("Sample format: {}", self.sample_format());
    }

    pub fn start(&mut self, start_time_tx: oneshot::Sender<Instant>) -> Result<(), String> {
        self.log_info();
        tracing::trace!("Building input stream...");

        let (receiver, stream) =
            (match self.supported_config.sample_format() {
                SampleFormat::I8 => self
                    .build_stream::<i8>(start_time_tx, |n| n as f32 / i8::MAX as f32 * 2.0 - 1.0),
                SampleFormat::I16 => self
                    .build_stream::<i16>(start_time_tx, |n| n as f32 / i16::MAX as f32 * 2.0 - 1.0),
                SampleFormat::I32 => self
                    .build_stream::<i32>(start_time_tx, |n| n as f32 / i32::MAX as f32 * 2.0 - 1.0),
                SampleFormat::U8 => self
                    .build_stream::<u8>(start_time_tx, |n| n as f32 / u8::MAX as f32 * 2.0 - 1.0),
                SampleFormat::U16 => self
                    .build_stream::<u16>(start_time_tx, |n| n as f32 / u16::MAX as f32 * 2.0 - 1.0),
                SampleFormat::U32 => self
                    .build_stream::<u32>(start_time_tx, |n| n as f32 / u32::MAX as f32 * 2.0 - 1.0),
                SampleFormat::F32 => self.build_stream::<f32>(start_time_tx, |n| n),
                SampleFormat::F64 => self.build_stream::<f64>(start_time_tx, |n| n as f32),
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

    fn build_stream<T: SizedSample + 'static>(
        &self,
        start_time_tx: oneshot::Sender<Instant>,
        convert_fn: fn(T) -> f32,
    ) -> Result<(SampleReceiver, Stream), String> {
        let (sender, receiver) = mpsc::channel(2048);

        let mut start_time_tx = Some(start_time_tx);

        self.device
            .build_input_stream(
                &self.config.clone(),
                move |data: &[T], _| {
                    match sender.try_send(Arc::new(
                        data.iter().map(|sample| convert_fn(*sample)).collect(),
                    )) {
                        Ok(_) => {
                            if let Some(start_time_option) = start_time_tx.take() {
                                start_time_option.send(Instant::now()).ok();

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
    mut capturer: AudioCapturer,
    pipe_path: PathBuf,
    start_writing_rx: watch::Receiver<bool>,
) -> (CaptureController, AudioCapturer) {
    let controller = CaptureController::new(pipe_path.clone());

    let (tx, rx) = oneshot::channel();

    capturer.start(tx).unwrap();

    create_named_pipe(&pipe_path).unwrap();

    println!("Starting audio channel senders...");
    let mut receiver = capturer
        .sample_receiver
        .take()
        .expect("Audio sample collection already started!");

    tokio::spawn({
        let controller = controller.clone();
        async move {
            println!("Opening audio pipe...");
            let mut pipe = File::create(&pipe_path).unwrap();
            println!("Audio pipe opened");

            while let Some(samples) = receiver.recv().await {
                if controller.is_stopped() {
                    println!("Stopping receiving camera frames");
                    break;
                }

                if !*start_writing_rx.borrow() || controller.is_paused() {
                    continue;
                }

                pipe.write_all(
                    &samples
                        .iter()
                        .flat_map(|f| f.to_le_bytes())
                        .collect::<Vec<_>>(),
                )
                .unwrap();
            }

            println!("Done receiving audio frames");

            pipe.sync_all().ok();
        }
    });

    rx.await.unwrap(); // wait for first frame

    (controller, capturer)
}

// ffmpeg
//     .command
//     .args(["-ac", &capturer.channels().to_string(), "-async", "1"])
//     .args([
//         "-af",
//         "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
//     ])
//     .arg(&output_path);

// pub async fn start_capturing(
//     mut capturer: AudioCapturer,
//     output_path: PathBuf,
//     start_writing_rx: watch::Receiver<bool>,
// ) -> CaptureController {
//     let controller = CaptureController::new(output_path);

//     let (tx, rx) = oneshot::channel();

//     capturer.start(tx).unwrap();
//     let sample_rate = capturer.sample_rate();

//     tokio::spawn({
//         let controller = controller.clone();
//         async move {
//             let mut receiver = capturer
//                 .sample_receiver
//                 .take()
//                 .expect("Audio sample collection already started!");

//             let mut encoder = MP3Encoder::new(&controller.output_path, sample_rate);

//             dbg!(encoder.context.frame_size());
//             let mut frame_buffer = Vec::<f32>::with_capacity(encoder.context.frame_size() as usize);

//             while let Some(samples) = receiver.recv().await {
//                 if controller.is_stopped() {
//                     println!("Stopping receiving audio frames");
//                     break;
//                 }

//                 if !*start_writing_rx.borrow() {
//                     continue;
//                 }

//                 if controller.is_paused() {
//                     // Skip writing data to pipe while paused
//                     continue;
//                 }

//                 let mut processed_samples = 0;
//                 while processed_samples < samples.len() {
//                     let buffer_remaining = frame_buffer.capacity() - frame_buffer.len();
//                     let src_range = 0..usize::min(samples.len(), buffer_remaining);

//                     processed_samples += src_range.len();

//                     frame_buffer.extend_from_slice(&samples[src_range]);

//                     if frame_buffer.len() < frame_buffer.capacity() {
//                         continue;
//                     }

//                     let mut frame = ffmpeg::frame::Audio::new(
//                         ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
//                         frame_buffer.len(),
//                         ffmpeg::ChannelLayout::MONO,
//                     );

//                     frame.data_mut(0).copy_from_slice(
//                         &frame_buffer
//                             .iter()
//                             .flat_map(|float| float.to_ne_bytes())
//                             .collect::<Vec<_>>(),
//                     );

//                     frame_buffer.clear();

//                     encoder.encode_frame(frame);
//                 }
//             }

//             capturer.stop().ok();

//             println!("Done receiving audio frames");
//         }
//     });

//     rx.await.unwrap(); // wait for first frame

//     controller
// }

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
