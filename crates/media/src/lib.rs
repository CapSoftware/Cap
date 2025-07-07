//! A modular multimedia processing framework, based on FFmpeg.
//!
//! It provides a `pipeline` abstraction for creating and controlling an entire operation,
//! as well as implementations of pipeline stages for individual tasks (encoding/decoding,
//! editing frames, composition, muxing, etc).

use std::borrow::Cow;

use data::AudioInfoError;
use thiserror::Error;

pub mod data;
pub mod device_fallback;
pub mod diagnostics;
pub mod encoders;
pub mod error_context;
pub mod feeds;
pub mod frame_ws;
pub mod pipeline;
pub mod platform;
pub mod sources;

// Re-export commonly used types
#[cfg(not(target_os = "android"))]
pub use diagnostics::SystemDiagnostics;

#[cfg(not(target_os = "android"))]
pub use error_context::{DeviceContext, ErrorContext, FfmpegErrorDetails, PerformanceMetrics};

use std::sync::atomic::AtomicBool;

static INITIALIZED: AtomicBool = AtomicBool::new(false);

pub fn init() -> Result<(), MediaError> {
    if !INITIALIZED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        tracing::debug!("Initializing media subsystem");
        ffmpeg::init()?;
    }

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

    #[error("Camera error: {0}")]
    Nokhwa(#[from] nokhwa::NokhwaError),

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

    #[error("{0}")]
    Other(String),
}
