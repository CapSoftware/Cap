//! A modular multimedia processing framework, based on FFmpeg.
//!
//! It provides a `pipeline` abstraction for creating and controlling an entire operation,
//! as well as implementations of pipeline stages for individual tasks (encoding/decoding,
//! editing frames, composition, muxing, etc).

use thiserror::Error;

pub mod data;
pub mod encoders;
pub mod filters;
pub mod pipeline;
pub mod platform;
pub mod sources;

pub fn init() -> Result<(), MediaError> {
    ffmpeg::init()?;

    Ok(())
}

#[derive(Error, Debug)]
pub enum MediaError {
    #[error("Media error: {0}")]
    Any(&'static str),

    #[error("Cannot build a pipeline without any tasks")]
    EmptyPipeline,

    #[error("Cannot run any further operations on a pipeline that has been shut down")]
    ShutdownPipeline,

    #[error("Failed to launch task: #{0}")]
    TaskLaunch(String),

    #[error("FFmpeg error: {0}")]
    FFmpeg(#[from] ffmpeg::Error),

    #[error("Could not find a suitable codec for {0}")]
    MissingCodec(&'static str),
}
