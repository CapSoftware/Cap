#[cfg(target_os = "macos")]
pub mod avassetreader;
pub mod ffmpeg;
#[cfg(target_os = "windows")]
pub mod media_foundation;
#[cfg(feature = "scripted")]
pub mod scripted;

#[cfg(target_os = "macos")]
pub use avassetreader::{AVAssetReaderDecoder, KeyframeIndex};
pub use ffmpeg::FFmpegDecoder;
#[cfg(target_os = "windows")]
pub use media_foundation::{
    FrameTextures, MFDecodedFrame, MFDecoderCapabilities, MediaFoundationDecoder, NV12Data,
    NV12Sample, get_mf_decoder_capabilities,
};
