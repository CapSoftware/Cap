use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::video::prores::{ProResEncoder, ProResEncoderError};

pub struct MOVFile {
    output: format::context::Output,
    video: ProResEncoder,
    is_finished: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("{0:?}")]
    Ffmpeg(ffmpeg::Error),
    #[error("Video/{0}")]
    VideoInit(ProResEncoderError),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

impl MOVFile {
    pub fn init(
        mut output: PathBuf,
        video: impl FnOnce(&mut format::context::Output) -> Result<ProResEncoder, ProResEncoderError>,
    ) -> Result<Self, InitError> {
        output.set_extension("mov");

        if let Some(parent) = output.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut output = format::output_as(&output, "mov").map_err(InitError::Ffmpeg)?;
        let video = video(&mut output).map_err(InitError::VideoInit)?;

        output.write_header().map_err(InitError::Ffmpeg)?;

        Ok(Self {
            output,
            video,
            is_finished: false,
        })
    }

    pub fn queue_video_frame(
        &mut self,
        frame: &mut frame::Video,
        timestamp: Duration,
    ) -> Result<(), crate::video::prores::QueueFrameError> {
        if self.is_finished {
            return Ok(());
        }

        self.video.queue_frame(frame, timestamp, &mut self.output)
    }

    pub fn finish(&mut self) -> Result<(), FinishError> {
        if self.is_finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.is_finished = true;

        self.video
            .flush(&mut self.output)
            .map_err(FinishError::WriteTrailerFailed)?;
        self.output
            .write_trailer()
            .map_err(FinishError::WriteTrailerFailed)?;

        Ok(())
    }
}

impl Drop for MOVFile {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
