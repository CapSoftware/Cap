use std::collections::VecDeque;

use ffmpeg::encoder;
pub use ffmpeg::util::frame::Audio as FFAudio;

use crate::data::{AudioInfo, PlanarData};
use cap_project::TimelineConfiguration;

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
        if let Some(pts) = frame.pts() {
            self.current_pts = pts;
        }
        if frame.is_planar() {
            for channel in 0..self.config.channels {
                self.data[channel].extend(frame.plane_data(channel));
            }
        } else {
            self.data[0].extend(
                &frame.data(0)
                    [0..frame.samples() * frame.channels() as usize * frame.format().bytes()],
            );
        }
    }

    pub fn next_frame(&mut self) -> Option<FFAudio> {
        if self.is_empty() {
            return None;
        }

        let frame_size = self.frame_size * self.config.sample_size();

        if self.len() < frame_size * self.config.channels {
            return None;
        }

        let mut frame = self.config.empty_frame(self.frame_size);
        frame.set_pts(Some(self.current_pts));

        if frame.is_planar() {
            for channel in 0..self.config.channels {
                for (index, byte) in self.data[channel].drain(0..frame_size).enumerate() {
                    frame.plane_data_mut(channel)[index] = byte;
                }
            }
        } else {
            for (index, byte) in self.data[0]
                .drain(0..frame_size * self.config.channels)
                .enumerate()
            {
                frame.plane_data_mut(0)[index] = byte;
            }
        }

        self.current_pts += i64::try_from(self.frame_size).unwrap();
        Some(frame)
    }

    pub fn next_frame_data(
        &mut self,
        samples: usize,
        timeline: Option<&TimelineConfiguration>,
    ) -> Option<(f64, Vec<u8>)> {
        if self.is_empty() {
            return None;
        }

        let frame_size = samples * self.config.sample_size();

        if self.len() < frame_size {
            return None;
        }

        let mut frame_data = Vec::with_capacity(frame_size * self.config.channels);
        for channel in 0..self.config.channels {
            frame_data.extend(self.data[channel].drain(0..frame_size));
        }

        let current_time = self.current_pts as f64 / f64::from(self.config.sample_rate);
        self.current_pts += i64::try_from(samples).unwrap();

        Some((current_time, frame_data))
    }
}
