use cap_media_info::AudioInfo;
use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::audio::aac::{AACEncoder, AACEncoderError};

pub struct FragmentedAudioFile {
    encoder: AACEncoder,
    output: format::context::Output,
    finished: bool,
    has_frames: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Encoder: {0}")]
    Encoder(#[from] AACEncoderError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

impl FragmentedAudioFile {
    pub fn init(mut output_path: PathBuf, audio_config: AudioInfo) -> Result<Self, InitError> {
        output_path.set_extension("m4a");

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut output = format::output_as(&output_path, "mp4")?;

        unsafe {
            let opts = output.as_mut_ptr();
            let key = std::ffi::CString::new("movflags").unwrap();
            let value =
                std::ffi::CString::new("frag_keyframe+empty_moov+default_base_moof").unwrap();
            ffmpeg::ffi::av_opt_set((*opts).priv_data, key.as_ptr(), value.as_ptr(), 0);
        }

        let encoder = AACEncoder::init(audio_config, &mut output)?;

        output.write_header()?;

        Ok(Self {
            encoder,
            output,
            finished: false,
            has_frames: false,
        })
    }

    pub fn encoder(&self) -> &AACEncoder {
        &self.encoder
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
    ) -> Result<(), ffmpeg::Error> {
        self.has_frames = true;
        self.encoder.send_frame(frame, timestamp, &mut self.output)
    }

    pub fn finish(&mut self) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        if self.finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.finished = true;

        if self.has_frames {
            let flush_result = self.encoder.flush(&mut self.output);
            self.output
                .write_trailer()
                .map_err(FinishError::WriteTrailerFailed)?;
            Ok(flush_result)
        } else {
            let _ = self.output.write_trailer();
            Ok(Ok(()))
        }
    }
}

impl Drop for FragmentedAudioFile {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
