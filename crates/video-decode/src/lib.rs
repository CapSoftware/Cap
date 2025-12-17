#[cfg(target_os = "macos")]
pub mod avassetreader;
pub mod ffmpeg;
#[cfg(target_os = "windows")]
pub mod media_foundation;

#[cfg(target_os = "macos")]
pub use avassetreader::AVAssetReaderDecoder;
pub use ffmpeg::FFmpegDecoder;
#[cfg(target_os = "windows")]
pub use media_foundation::{MFDecodedFrame, MediaFoundationDecoder, NV12Data};
