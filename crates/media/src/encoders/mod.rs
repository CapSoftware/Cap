use std::path::PathBuf;

mod h264;
#[cfg(target_os = "macos")]
mod h264_avassetwriter;
mod mp4;
mod opus;

pub use h264::*;
#[cfg(target_os = "macos")]
pub use h264_avassetwriter::*;
pub use mp4::*;
pub use opus::*;

pub enum Output {
    File(PathBuf),
}
