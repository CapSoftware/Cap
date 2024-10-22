use ffmpeg::{
    format::sample::{Sample, Type},
    software::resampling,
};
use flume::{Sender, TryRecvError};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::{path::PathBuf, sync::Arc, time::Duration};

use crate::{
    data::{AudioInfo, FFAudio, FromByteSlice},
    MediaError,
};

enum AudioFeedControl {
    Start(Duration),
    Stop,
    Shutdown,
}

#[derive(Clone)]
pub struct AudioData {
    pub buffer: Arc<Vec<u8>>,
    pub info: AudioInfo,
}

impl AudioData {
    pub fn from_file(_path: PathBuf) -> Result<Self, MediaError> {
        todo!()
    }
}

pub struct AudioFeedHandle {
    sender: Sender<AudioFeedControl>,
    join_handle: std::thread::JoinHandle<()>,
}

impl AudioFeedHandle {
    pub fn start(&self, playhead: Option<Duration>) -> Result<(), MediaError> {
        self.sender
            .send(AudioFeedControl::Start(playhead.unwrap_or(Duration::ZERO)))
            .map_err(|_| MediaError::Any("Audio feed is unreachable!"))?;

        Ok(())
    }

    pub fn stop(&self) -> Result<(), MediaError> {
        self.sender
            .send(AudioFeedControl::Stop)
            .map_err(|_| MediaError::Any("Audio feed is unreachable!"))?;

        Ok(())
    }
}

impl Drop for AudioFeedHandle {
    fn drop(&mut self) {
        if let Err(_) = self.sender.send(AudioFeedControl::Shutdown) {
            eprintln!("Audio stream has already shut down.");
        }
    }
}

pub struct AudioFeedConsumer<T: FromByteSlice> {
    consumer: HeapCons<u8>,
    marker: std::marker::PhantomData<T>,
}

impl<T: FromByteSlice> AudioFeedConsumer<T> {
    fn new(consumer: HeapCons<u8>) -> Self {
        Self {
            consumer,
            marker: std::marker::PhantomData,
        }
    }

    pub fn clear(&mut self) {
        self.consumer.clear();
    }

    pub fn fill(&mut self, data: &mut [T]) {
        let mut byte_data = vec![0; data.len() * T::BYTE_SIZE];
        let _ = self.consumer.pop_slice(&mut byte_data);

        T::cast_slice(&byte_data, data);
    }
}

pub struct AudioFeed {
    resampler: resampling::Context,
    data: AudioData,
    cursor: usize,
    resampled_buffer: HeapProd<u8>,
    resampled_frame: FFAudio,
    resampling_delay: Option<resampling::Delay>,
}

impl AudioFeed {
    pub const FORMAT: Sample = Sample::F64(Type::Packed);
    const SAMPLES_COUNT: usize = 1024;

    pub fn build<T: FromByteSlice>(
        data: AudioData,
        output_info: AudioInfo,
    ) -> (AudioFeedConsumer<T>, Self) {
        println!("Input info: {:?}", data.info);
        println!("Output info: {:?}", output_info);
        let resampler = ffmpeg::software::resampler(
            (
                data.info.sample_format,
                data.info.channel_layout(),
                data.info.sample_rate,
            ),
            (
                output_info.sample_format,
                output_info.channel_layout(),
                output_info.sample_rate,
            ),
        )
        .unwrap();

        let capacity = data.buffer.len() * 10;
        let buffer = HeapRb::new(capacity);
        let (sample_producer, sample_consumer) = buffer.split();

        (
            AudioFeedConsumer::new(sample_consumer),
            Self {
                resampler,
                data,
                cursor: 0,
                resampled_buffer: sample_producer,
                resampled_frame: FFAudio::empty(),
                resampling_delay: None,
            },
        )
    }

    pub fn set_playhead(&mut self, playhead: Duration) {
        let input_def = self.resampler.input();
        let channel_count = usize::try_from(input_def.channel_layout.channels()).unwrap();
        let bytes_per_sample = input_def.format.bytes();

        let estimated_samples = playhead.as_nanos() * u128::from(input_def.rate) / 1_000_000_000;
        self.cursor =
            usize::try_from(estimated_samples).unwrap() * channel_count * bytes_per_sample;
        self.resampling_delay = None;
    }

    pub fn produce_samples(&mut self) -> bool {
        if self.cursor >= self.data.buffer.len() {
            if self.resampling_delay.is_none() {
                return false;
            };

            self.resampling_delay = self.resampler.flush(&mut self.resampled_frame).unwrap();
            self.resampled_buffer
                .push_slice(self.resampled_frame.data(0));

            return true;
        }

        let bytes_per_sample = self.data.info.sample_format.bytes();

        let mut samples = Self::SAMPLES_COUNT;
        let mut chunk_size = samples * self.data.info.channels * bytes_per_sample;
        let remaining_chunk = self.data.buffer.len() - self.cursor;

        if remaining_chunk < chunk_size {
            chunk_size = remaining_chunk;
            samples = remaining_chunk / (self.data.info.channels * bytes_per_sample);
        }

        let mut raw_frame = FFAudio::new(
            self.data.info.sample_format,
            samples,
            self.data.info.channel_layout(),
        );
        raw_frame.set_rate(self.data.info.sample_rate);
        let start = self.cursor;
        let end = self.cursor + chunk_size;
        raw_frame.data_mut(0)[0..chunk_size].copy_from_slice(&self.data.buffer[start..end]);
        self.cursor = end;

        // let mut resampled_frame = FFAudio::empty();
        self.resampling_delay = self
            .resampler
            .run(&raw_frame, &mut self.resampled_frame)
            .unwrap();
        self.resampled_buffer
            .push_slice(self.resampled_frame.data(0));

        true
    }

    pub fn launch(mut self) -> AudioFeedHandle {
        println!("Launching audio feed stream");
        let (control_sender, control) = flume::bounded(10);

        let join_handle = std::thread::spawn(move || {
            let control_signal_handler = |feed: &mut Self, signal: AudioFeedControl| match signal {
                AudioFeedControl::Start(playhead) => {
                    feed.set_playhead(playhead);
                    Some(feed.produce_samples())
                }
                AudioFeedControl::Stop => Some(false),
                AudioFeedControl::Shutdown => {
                    println!("Received audio feed shutdown signal.");
                    None
                }
            };

            loop {
                match control.try_recv() {
                    Ok(signal) => match control_signal_handler(&mut self, signal) {
                        Some(should_continue) => {
                            if should_continue {
                                continue;
                            }
                        }
                        None => break,
                    },
                    Err(TryRecvError::Empty) => {
                        self.produce_samples();
                        continue;
                    }
                    Err(TryRecvError::Disconnected) => {
                        eprintln!("Audio feed control signal lost.");
                        break;
                    }
                }

                // Wait for new start signal
                if let Ok(signal) = control.recv() {
                    if control_signal_handler(&mut self, signal).is_none() {
                        break;
                    }
                } else {
                    eprintln!("Audio feed control signal lost.");
                    break;
                }
            }
        });

        AudioFeedHandle {
            sender: control_sender,
            join_handle,
        }
    }
}
