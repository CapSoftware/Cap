#[cfg(target_os = "macos")]
mod screencapturekit;
#[cfg(target_os = "macos")]
pub use screencapturekit::*;

#[cfg(windows)]
mod direct3d;
#[cfg(windows)]
pub use direct3d::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

mod cpal;
pub use cpal::*;

pub trait AsFFmpeg {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
