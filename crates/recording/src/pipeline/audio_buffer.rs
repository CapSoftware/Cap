use cap_audio::cast_bytes_to_f32_slice;

use cap_media_info::{AudioInfo, PlanarData};
use ffmpeg::encoder;
pub use ffmpeg::util::frame::Audio as FFAudio;
use std::collections::VecDeque;

#[derive(Debug)]
pub struct AudioBuffer {
    pub data: Vec<VecDeque<f32>>,
    pub frame_size: usize,
    config: AudioInfo,
    frame: FFAudio,
}

impl AudioBuffer {
    pub fn new(config: AudioInfo, encoder: &encoder::Audio) -> Self {
        let sample_size = config.sample_size();
        let frame_buffer_size = usize::try_from(config.buffer_size).unwrap() * sample_size;

        let frame_size = encoder.frame_size() as usize;

        Self {
            data: vec![VecDeque::with_capacity(frame_buffer_size); config.channels],
            frame_size,
            config,
            frame: FFAudio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                frame_size,
                ffmpeg::ChannelLayout::default(config.channels as i32),
            ),
        }
    }

    fn is_empty(&self) -> bool {
        self.data[0].is_empty()
    }

    fn len(&self) -> usize {
        self.data[0].len()
    }

    pub fn consume(&mut self, frame: &FFAudio) {
        if frame.samples() == 0 {
            return;
        }

        if frame.is_planar() {
            for channel in 0..self.config.channels {
                self.data[channel]
                    .extend(unsafe { cast_bytes_to_f32_slice(frame.plane_data(channel)) });
            }
        } else {
            self.data[0].extend(unsafe {
                cast_bytes_to_f32_slice(
                    &frame.data(0)[0..frame.samples() * frame.channels() as usize],
                )
            });
        }
    }

    pub fn next_frame(&mut self, drain: bool) -> Option<&FFAudio> {
        if self.is_empty() {
            return None;
        }

        if !drain && self.len() < self.frame_size * self.config.channels {
            return None;
        }

        let actual_samples_per_channel = if drain {
            (self.len() / self.config.channels).min(self.frame_size)
        } else {
            self.frame_size
        };

        if self.frame.is_planar() {
            for channel in 0..self.config.channels {
                for (index, byte) in self.data[channel]
                    .drain(0..actual_samples_per_channel)
                    .enumerate()
                {
                    self.frame.plane_data_mut(channel)[index * 4..(index + 1) * 4]
                        .copy_from_slice(&byte.to_ne_bytes());
                }
            }
        } else {
            for (index, byte) in self.data[0]
                .drain(0..actual_samples_per_channel * self.config.channels)
                .enumerate()
            {
                self.frame.plane_data_mut(0)[index * 4..(index + 1) * 4]
                    .copy_from_slice(&byte.to_ne_bytes());
            }
        }

        Some(&self.frame)
    }
}
