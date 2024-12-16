use std::collections::VecDeque;

use ffmpeg::encoder;
pub use ffmpeg::util::frame::Audio as FFAudio;

use crate::data::{AudioInfo, PlanarData};

#[derive(Debug)]
pub struct AudioBuffer {
    current_pts: i64,
    data: Vec<VecDeque<u8>>,
    frame_size: usize,
    config: AudioInfo,
}

impl AudioBuffer {
    pub fn new(config: AudioInfo, encoder: &encoder::Audio) -> Self {
        let sample_size = config.sample_size();
        let frame_buffer_size = usize::try_from(config.buffer_size).unwrap() * sample_size;

        Self {
            current_pts: 0,
            data: vec![VecDeque::with_capacity(frame_buffer_size); config.channels],
            frame_size: encoder.frame_size().try_into().unwrap(),
            config,
        }
    }

    fn is_empty(&self) -> bool {
        self.data[0].is_empty()
    }

    fn len(&self) -> usize {
        self.data[0].len()
    }

    pub fn consume(&mut self, frame: FFAudio) {
        // TODO: Set PTS from frame with ffmpeg::sys::av_rescale_q??
        // if let Some(pts) = frame.pts() {
        //     self.current_pts = pts;
        // }
        for channel in 0..self.config.channels {
            // if self.current_pts == 0 {
            //     println!("Data in channel {channel}: {:?}", frame.data(channel));
            // }
            self.data[channel].extend(frame.plane_data(channel));
        }
    }

    pub fn next_frame(&mut self) -> Option<FFAudio> {
        if self.is_empty() {
            return None;
        }

        let frame_size = self.frame_size * self.config.sample_size();

        if self.len() < frame_size {
            return None;
        }

        let mut frame = self.config.empty_frame(self.frame_size);
        frame.set_pts(Some(self.current_pts));

        for channel in 0..self.config.channels {
            for (index, byte) in self.data[channel].drain(0..frame_size).enumerate() {
                frame.plane_data_mut(channel)[index] = byte;
            }
        }

        self.current_pts += i64::try_from(frame_size / self.config.sample_size()).unwrap();
        Some(frame)
    }
}
