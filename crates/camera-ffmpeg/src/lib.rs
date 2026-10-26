mod mjpeg_idct;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

pub trait CapturedFrameExt {
    /// Creates an ffmpeg video frame from the native frame.
    /// Only size, format, and data are set.
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;

    /// Like [`as_ffmpeg`](Self::as_ffmpeg), but MJPEG may decode with a scaled
    /// IDCT when `max_width`×`max_height` is smaller than the frame. The
    /// result still covers that rectangle. Other pixel formats are unchanged.
    fn as_ffmpeg_covering(
        &self,
        max_width: u32,
        max_height: u32,
    ) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
