#[cfg(target_os = "macos")]
mod aac_avassetwriter;
mod h264;
#[cfg(target_os = "macos")]
mod h264_avassetwriter;
mod mp4;
mod opus;
#[cfg(target_os = "macos")]
mod split_avassetwriter;

#[cfg(target_os = "macos")]
pub use aac_avassetwriter::*;
pub use h264::*;
#[cfg(target_os = "macos")]
pub use h264_avassetwriter::*;
pub use mp4::*;
pub use opus::*;
#[cfg(target_os = "macos")]
pub use split_avassetwriter::*;
