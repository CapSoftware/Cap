use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, Device, SampleFormat, SizedSample, Stream, StreamConfig, SupportedStreamConfig,
};
use flume::Receiver;
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapProd, HeapRb,
};
use std::{thread, time::Duration};

use crate::{
    data::{ffmpeg_sample_format_for, AudioInfo, FFAudio},
    pipeline::{
        clock::{PipelineClock, RecordedClock},
        task::PipelineSinkTask,
    },
    MediaError,
};

pub struct AudioOutputSink {
    clock: RecordedClock,
    device: Device,
    device_name: String,
    ss_config: SupportedStreamConfig,
    info: AudioInfo,
}

impl AudioOutputSink {
    // TODO: Support device selection like with input.
    // There's a lot of overlap between the implementations of input and output.
    // Maybe that can be consolidated somehow.
    pub fn init(clock: RecordedClock) -> Option<Self> {
        let host = cpal::default_host();
        let device = host.default_output_device().unwrap();
        let device_name = device.name().unwrap();

        device
            .default_output_config()
            .ok()
            .filter(|c| ffmpeg_sample_format_for(c.sample_format()).is_some())
            .map(|ss_config| {
                let mut info = AudioInfo::from_stream_config(&ss_config);
                info.sample_format = info.sample_format.packed();

                Self {
                    clock,
                    device,
                    device_name,
                    info,
                    ss_config,
                }
            })
    }

    pub fn info(&self) -> AudioInfo {
        self.info
    }

    pub fn build_stream<T: SizedSample>(&self) -> Result<(HeapProd<u8>, Stream), MediaError> {
        let mut config: StreamConfig = self.ss_config.config();
        // Low-latency playback
        config.buffer_size = BufferSize::Fixed(256);
        let sample_format = self.ss_config.sample_format();
        let bytes_per_sample = sample_format.sample_size();

        // Up to 1 second of pre-rendered audio
        let capacity =
            (config.sample_rate.0 as usize) * (config.channels as usize) * bytes_per_sample;
        let buffer = HeapRb::new(capacity);
        let (sample_producer, mut sample_consumer) = buffer.split();

        let clock = self.clock.clone();
        let mut playing = false;

        let data_callback = move |data: &mut cpal::Data, _: &cpal::OutputCallbackInfo| {
            let old_playing = playing;
            let mut bytes_written = 0;

            playing = clock.running();
            if playing {
                bytes_written = sample_consumer.pop_slice(data.bytes_mut());
            } else if old_playing {
                sample_consumer.clear();
            }

            let samples_written = bytes_written / bytes_per_sample;
            data.as_slice_mut::<T>().expect("Wrong sample format!")[samples_written..]
                .fill(T::EQUILIBRIUM);
        };

        self.device
            .build_output_stream_raw(&config, sample_format, data_callback, |_| {}, None)
            .map(|stream| (sample_producer, stream))
            .map_err(|error| {
                eprintln!("Error while preparing audio playback: {error}");
                MediaError::TaskLaunch("Failed to start audio playback".into())
            })
    }
}

impl PipelineSinkTask for AudioOutputSink {
    type Input = FFAudio;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: Receiver<Self::Input>,
    ) {
        println!("Preparing audio playback thread...");

        let build_stream_result = match self.ss_config.sample_format() {
            SampleFormat::U8 => self.build_stream::<u8>(),
            SampleFormat::I16 => self.build_stream::<i16>(),
            SampleFormat::I32 => self.build_stream::<i32>(),
            SampleFormat::I64 => self.build_stream::<i64>(),
            SampleFormat::F32 => self.build_stream::<f32>(),
            SampleFormat::F64 => self.build_stream::<f64>(),
            _ => unreachable!(),
        };

        match build_stream_result {
            Err(error) => ready_signal.send(Err(error)).unwrap(),
            Ok((mut samples, stream)) => {
                println!("Using audio output device {}", self.device_name);
                stream.play().expect("Failed to start audio playback");

                ready_signal.send(Ok(())).unwrap();

                while let Ok(frame) = input.recv() {
                    if !self.clock.running() {
                        let _ = input.drain();
                        continue;
                    }

                    if frame.format() != self.info.sample_format
                        || frame.rate() != self.info.sample_rate
                    {
                        eprintln!("Audio frame does not match playback parameters!");
                        break;
                    }

                    let data = frame.data(0);
                    let safety_zone = 2 * data.len();
                    samples.push_slice(data);

                    if samples.vacant_len() < safety_zone {
                        thread::sleep(Duration::from_millis(1));
                    }
                }

                stream.pause().ok();
                drop(stream);
            }
        }
    }
}
