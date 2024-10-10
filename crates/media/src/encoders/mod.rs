use std::path::PathBuf;

mod h264;
mod mp3;

pub use h264::*;
pub use mp3::*;

pub enum Output {
    File(PathBuf),
}
