#[cfg(target_os = "macos")]
mod screencapturekit;
#[cfg(target_os = "macos")]
pub use screencapturekit::*;

// #[cfg(windows)]
mod direct3d;
// #[cfg(windows)]
pub use direct3d::*;

pub trait AsFFmpeg {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
