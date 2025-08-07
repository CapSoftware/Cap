#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

pub trait CapturedFrameExt {
    /// Creates an ffmpeg video frame from the native frame.
    /// Only size, format, and data are set.
    fn to_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ToFfmpegError>;
}
