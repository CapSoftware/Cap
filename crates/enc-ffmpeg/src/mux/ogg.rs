use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::audio::opus::{OpusEncoder, OpusEncoderError};

pub struct OggFile {
    encoder: OpusEncoder,
    output: format::context::Output,
    finished: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
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

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
    ) -> Result<(), ffmpeg::Error> {
        self.encoder.queue_frame(frame, timestamp, &mut self.output)
    }

    pub fn finish(&mut self) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        if self.finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.finished = true;

        let flush_result = self.encoder.flush(&mut self.output);
        self.output
            .write_trailer()
            .map_err(FinishError::WriteTrailerFailed)?;

        Ok(flush_result)
    }
}

impl Drop for OggFile {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
