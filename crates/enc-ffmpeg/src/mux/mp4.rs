use cap_media_info::RawVideoFormat;
use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};
use tracing::{info, trace};

use crate::{
    audio::AudioEncoder,
    video::{H264Encoder, H264EncoderError},
};

pub struct MP4File {
    #[allow(unused)]
    tag: &'static str,
    output: format::context::Output,
    video: H264Encoder,
    audio: Option<Box<dyn AudioEncoder + Send>>,
    is_finished: bool,
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

impl MP4File {
    pub fn init(
        tag: &'static str,
        mut output: PathBuf,
        video: impl FnOnce(&mut format::context::Output) -> Result<H264Encoder, H264EncoderError>,
        audio: impl FnOnce(
            &mut format::context::Output,
        )
            -> Option<Result<Box<dyn AudioEncoder + Send>, Box<dyn std::error::Error>>>,
    ) -> Result<Self, InitError> {
        output.set_extension("mp4");

        if let Some(parent) = output.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut output = format::output(&output).map_err(InitError::Ffmpeg)?;

        trace!("Preparing encoders for mp4 file");

        let video = video(&mut output).map_err(InitError::VideoInit)?;
        let audio = audio(&mut output)
            .transpose()
            .map_err(InitError::AudioInit)?;

        info!("Prepared encoders for mp4 file");

        // make sure this happens after adding all encoders!
        output.write_header().map_err(InitError::Ffmpeg)?;

        Ok(Self {
            tag,
            output,
            video,
            audio,
            is_finished: false,
        })
    }

    pub fn video_format() -> RawVideoFormat {
        RawVideoFormat::YUYV420
    }

    pub fn queue_video_frame(&mut self, frame: frame::Video, timestamp: Duration) {
        if self.is_finished {
            return;
        }

        self.video.queue_frame(frame, timestamp, &mut self.output);
    }

    pub fn queue_audio_frame(&mut self, frame: frame::Audio) {
        if self.is_finished {
            return;
        }

        let Some(audio) = &mut self.audio else {
            return;
        };

        audio.send_frame(frame, &mut self.output);
    }

    pub fn finish(&mut self) {
        if self.is_finished {
            return;
        }

        self.is_finished = true;

        tracing::info!("MP4Encoder: Finishing encoding");

        self.video.finish(&mut self.output);

        if let Some(audio) = &mut self.audio {
            tracing::info!("MP4Encoder: Flushing audio encoder");
            audio.finish(&mut self.output);
        }

        tracing::info!("MP4Encoder: Writing trailer");
        if let Err(e) = self.output.write_trailer() {
            tracing::error!("Failed to write MP4 trailer: {:?}", e);
        }
    }

    pub fn video(&self) -> &H264Encoder {
        &self.video
    }

    pub fn video_mut(&mut self) -> &mut H264Encoder {
        &mut self.video
    }
}

impl Drop for MP4File {
    fn drop(&mut self) {
        self.finish();
    }
}

pub struct MP4Input {
    pub video: frame::Video,
    pub audio: Option<frame::Audio>,
}

unsafe impl Send for H264Encoder {}
