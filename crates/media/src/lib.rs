//! A modular multimedia processing framework, based on FFmpeg.
//!
//! It provides a `pipeline` abstraction for creating and controlling an entire operation,
//! as well as implementations of pipeline stages for individual tasks (encoding/decoding,
//! editing frames, composition, muxing, etc).

use std::borrow::Cow;

use cap_media_info::AudioInfoError;
use thiserror::Error;

pub fn init() -> Result<(), MediaError> {
    ffmpeg::init()?;

    Ok(())
}

#[derive(Error, Debug)]
pub enum MediaError {
    #[error("{0}")]
    Any(Cow<'static, str>),

    #[error("Cannot build a pipeline without any tasks")]
    EmptyPipeline,

    #[error("Cannot run any further operations on a pipeline that has been shut down")]
    ShutdownPipeline,

    #[error("Failed to launch task: {0}")]
    TaskLaunch(String),

    #[error("FFmpeg error: {0}")]
    FFmpeg(#[from] ffmpeg::Error),

    #[error("IO error: {0}")]
    IO(#[from] std::io::Error),

    #[error("Could not find a suitable codec for {0}")]
    MissingCodec(&'static str),

    #[error("Device {0} is unreachable. It may have been disconnected")]
    DeviceUnreachable(String),

    #[error("Could not find a suitable {0} stream in this file")]
    MissingMedia(&'static str),

    #[error("AudioInfo: {0}")]
    AudioInfoError(#[from] AudioInfoError),
}
