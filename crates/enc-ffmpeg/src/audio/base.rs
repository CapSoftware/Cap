use super::buffered_resampler::BufferedResampler;
use crate::base::EncoderBase;
use ffmpeg::{codec::encoder, format, frame};
use std::time::Duration;

pub struct AudioEncoderBase {
    inner: EncoderBase,
    encoder: encoder::Audio,
    resampler: BufferedResampler,
}

impl AudioEncoderBase {
    pub fn new(encoder: encoder::Audio, resampler: BufferedResampler, stream_index: usize) -> Self {
        Self {
            inner: EncoderBase::new(stream_index),
            encoder,
            resampler,
        }
    }

    pub fn send_frame(
        &mut self,
        mut frame: frame::Audio,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), ffmpeg::Error> {
        // Input frames are stamped in input-rate units; BufferedResampler
        // rescales them to the encoder's output rate.
        let input_rate = f64::from(self.resampler.input().rate);
        self.inner
            .update_pts_with_rate(&mut frame, timestamp, input_rate);

        self.resampler.add_frame(frame);

        while let Some(frame) = self.resampler.get_frame(self.encoder.frame_size() as usize) {
            self.inner.send_frame(&frame, output, &mut self.encoder)?;
        }

        Ok(())
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        while let Some(frame) = self.resampler.flush(self.encoder.frame_size() as usize) {
            self.inner.send_frame(&frame, output, &mut self.encoder)?;
        }

        self.inner.process_eof(output, &mut self.encoder)
    }
}
