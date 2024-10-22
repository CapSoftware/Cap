use ffmpeg::{
    format::sample::{Sample, Type},
    software::resampling,
};
use flume::{Sender, TryRecvError};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::{path::PathBuf, sync::Arc, time::Duration};

use crate::{
    data::{AudioInfo, FFAudio, FromByteSlice},
    MediaError,
};

enum AudioFeedControl {
    Start(u32),
    Stop,
    Shutdown,
}

#[derive(Clone)]
pub struct AudioFeedData {
    pub buffer: Arc<Vec<u8>>,
    pub info: AudioInfo,
}

impl AudioFeedData {
    pub fn from_file(_path: PathBuf) -> Result<Self, MediaError> {
        todo!()
    }
}

pub struct AudioFeedHandle {
    sender: Sender<AudioFeedControl>,
    join_handle: std::thread::JoinHandle<()>,
}

impl AudioFeedHandle {
    pub fn start(&self, playhead: Option<u32>) -> Result<(), MediaError> {
        self.sender
            .send(AudioFeedControl::Start(playhead.unwrap_or(0)))
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
    data: AudioFeedData,
    cursor: usize,
    resampled_buffer: HeapProd<u8>,
    resampled_frame: FFAudio,
    resampling_delay: Option<resampling::Delay>,
    video_frame_duration: f64,
}

impl AudioFeed {
    pub const FORMAT: Sample = Sample::F64(Type::Packed);
    const SAMPLES_COUNT: usize = 2048;

    pub fn build<T: FromByteSlice>(
        data: AudioFeedData,
        output_info: AudioInfo,
        video_frame_duration: f64,
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

        // Up to 1 second of pre-rendered audio
        let capacity = (output_info.sample_rate as usize)
            * (output_info.channels as usize)
            * output_info.sample_format.bytes();
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
                video_frame_duration,
            },
        )
    }

    pub fn set_playhead(&mut self, playhead: u32) {
        let chunk_size = self.data.info.channels * self.data.info.sample_format.bytes();
        let total_samples = self.data.buffer.len() / chunk_size;

        let estimated_cursor =
            (total_samples as f64) * f64::from(playhead) / self.video_frame_duration;
        let cursor: usize = num_traits::cast(estimated_cursor).unwrap();
        self.cursor = cursor * chunk_size;
        self.resampling_delay = None;
    }

    pub fn produce_samples(&mut self) -> bool {
        let bytes_per_sample = self.data.info.sample_format.bytes();

        let mut samples = Self::SAMPLES_COUNT;
        let mut chunk_size = samples * self.data.info.channels * bytes_per_sample;

        let space_available = self.resampled_buffer.vacant_len() > 2 * chunk_size;

        if self.cursor >= self.data.buffer.len() {
            if self.resampling_delay.is_none() {
                return false;
            };

            if space_available {
                self.resampling_delay = self.resampler.flush(&mut self.resampled_frame).unwrap();
                self.resampled_buffer
                    .push_slice(self.resampled_frame.data(0));
            }

            return true;
        }

        if space_available {
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

            self.resampling_delay = self
                .resampler
                .run(&raw_frame, &mut self.resampled_frame)
                .unwrap();
            self.resampled_buffer
                .push_slice(self.resampled_frame.data(0));
        } else {
            // TODO: remove this sleep to enable using the resampler in the same thread.
            std::thread::sleep(Duration::from_millis(5));
        }

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
