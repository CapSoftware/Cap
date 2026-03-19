#![cfg(windows)]

mod audio;
mod h264;

pub use audio::AudioExt;
pub use h264::{H264StreamMuxer, MuxerConfig, set_fragmented_mp4_options};
