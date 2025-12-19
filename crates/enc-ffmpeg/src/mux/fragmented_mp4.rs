use cap_media_info::RawVideoFormat;
use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};
use tracing::*;

use crate::{
    audio::AudioEncoder,
    h264,
    video::h264::{H264Encoder, H264EncoderError},
};

pub struct FragmentedMP4File {
    output: format::context::Output,
    video: H264Encoder,
    audio: Option<Box<dyn AudioEncoder + Send>>,
    is_finished: bool,
    has_frames: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("{0:?}")]
    Ffmpeg(ffmpeg::Error),
    #[error("Video/{0}")]
    VideoInit(H264EncoderError),
    #[error("Audio/{0}")]
    AudioInit(Box<dyn std::error::Error>),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

pub struct FinishResult {
    pub video_finish: Result<(), ffmpeg::Error>,
    pub audio_finish: Result<(), ffmpeg::Error>,
}

impl FragmentedMP4File {
    pub fn init(
        mut output_path: PathBuf,
        video: impl FnOnce(&mut format::context::Output) -> Result<H264Encoder, H264EncoderError>,
        audio: impl FnOnce(
            &mut format::context::Output,
        )
            -> Option<Result<Box<dyn AudioEncoder + Send>, Box<dyn std::error::Error>>>,
    ) -> Result<Self, InitError> {
        output_path.set_extension("mp4");

        if let Some(parent) = output_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut output = format::output_as(&output_path, "mp4").map_err(InitError::Ffmpeg)?;

        unsafe {
            let opts = output.as_mut_ptr();
            let key = std::ffi::CString::new("movflags").unwrap();
            let value =
                std::ffi::CString::new("frag_keyframe+empty_moov+default_base_moof").unwrap();
            ffmpeg::ffi::av_opt_set((*opts).priv_data, key.as_ptr(), value.as_ptr(), 0);
        }

        trace!("Preparing encoders for fragmented mp4 file");

        let video = video(&mut output).map_err(InitError::VideoInit)?;
        let audio = audio(&mut output)
            .transpose()
            .map_err(InitError::AudioInit)?;

        info!("Prepared encoders for fragmented mp4 file");

        output.write_header().map_err(InitError::Ffmpeg)?;

        Ok(Self {
            output,
            video,
            audio,
            is_finished: false,
            has_frames: false,
        })
    }

    pub fn video_format() -> RawVideoFormat {
        RawVideoFormat::Yuv420p
    }

    pub fn queue_video_frame(
        &mut self,
        frame: frame::Video,
        timestamp: Duration,
    ) -> Result<(), h264::QueueFrameError> {
        if self.is_finished {
            return Ok(());
        }

        self.has_frames = true;
        self.video.queue_frame(frame, timestamp, &mut self.output)
    }

    pub fn queue_audio_frame(&mut self, frame: frame::Audio) {
        if self.is_finished {
            return;
        }

        let Some(audio) = &mut self.audio else {
            return;
        };

        self.has_frames = true;
        audio.send_frame(frame, &mut self.output);
    }

    pub fn finish(&mut self) -> Result<FinishResult, FinishError> {
        if self.is_finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.is_finished = true;

        tracing::info!("FragmentedMP4File: Finishing encoding");

        let video_finish = self.video.flush(&mut self.output).inspect_err(|e| {
            error!("Failed to finish video encoder: {e:#}");
        });

        let audio_finish = self
            .audio
            .as_mut()
            .map(|enc| {
                tracing::info!("FragmentedMP4File: Flushing audio encoder");
                enc.flush(&mut self.output).inspect_err(|e| {
                    error!("Failed to finish audio encoder: {e:#}");
                })
            })
            .unwrap_or(Ok(()));

        tracing::info!("FragmentedMP4File: Writing trailer");
        self.output
            .write_trailer()
            .map_err(FinishError::WriteTrailerFailed)?;

        Ok(FinishResult {
            video_finish,
            audio_finish,
        })
    }

    pub fn video(&self) -> &H264Encoder {
        &self.video
    }

    pub fn video_mut(&mut self) -> &mut H264Encoder {
        &mut self.video
    }
}

impl Drop for FragmentedMP4File {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
