#[cfg(target_os = "macos")]
pub mod avassetreader;
pub mod ffmpeg;

#[cfg(target_os = "macos")]
pub use avassetreader::AVAssetReaderDecoder;
pub use ffmpeg::FFmpegDecoder;
