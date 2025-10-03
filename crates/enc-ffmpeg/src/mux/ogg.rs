use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::audio::{OpusEncoder, OpusEncoderError};

pub struct OggFile {
    encoder: OpusEncoder,
    output: format::context::Output,
    finished: bool,
}

impl OggFile {
    pub fn init(
        mut output: PathBuf,
        encoder: impl FnOnce(&mut format::context::Output) -> Result<OpusEncoder, OpusEncoderError>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        output.set_extension("ogg");
        let mut output = format::output(&output)?;

        let encoder = encoder(&mut output)?;

        // make sure this happens after adding all encoders!
        output.write_header()?;

        Ok(Self {
            encoder,
            output,
            finished: false,
        })
    }

    pub fn encoder(&self) -> &OpusEncoder {
        &self.encoder
    }

    pub fn queue_frame(&mut self, frame: frame::Audio, timestamp: Duration) {
        let _ = self.encoder.queue_frame(frame, timestamp, &mut self.output);
    }

    pub fn finish(&mut self) {
        if !self.finished {
            let _ = self.encoder.finish(&mut self.output);
            self.output.write_trailer().unwrap();
            self.finished = true;
        }
    }
}

impl Drop for OggFile {
    fn drop(&mut self) {
        self.finish();
    }
}
