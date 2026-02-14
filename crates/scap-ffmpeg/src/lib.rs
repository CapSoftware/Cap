#[cfg(target_os = "macos")]
mod screencapturekit;
#[cfg(target_os = "macos")]
pub use screencapturekit::*;

#[cfg(windows)]
mod direct3d;
#[cfg(windows)]
pub use direct3d::*;

mod cpal;
pub use cpal::*;

#[cfg(not(any(target_os = "macos", windows)))]
#[derive(Debug, Clone, Copy)]
pub struct AsFFmpegError;

#[cfg(not(any(target_os = "macos", windows)))]
impl std::fmt::Display for AsFFmpegError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FFmpeg conversion is unsupported on this platform")
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl std::error::Error for AsFFmpegError {}

pub trait AsFFmpeg {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
