use std::path::PathBuf;

mod h264;
#[cfg(target_os = "macos")]
mod h264_avassetwriter;
mod mp3;

pub use h264::*;
#[cfg(target_os = "macos")]
pub use h264_avassetwriter::*;
pub use mp3::*;

pub enum Output {
    File(PathBuf),
}
