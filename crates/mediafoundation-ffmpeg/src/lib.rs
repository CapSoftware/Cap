#![cfg(windows)]

mod audio;
mod h264;

pub use audio::AudioExt;
pub use h264::{
    H264StreamMuxer, MF_TIMEBASE, MuxerConfig, sample_to_packet, set_fragmented_mp4_options,
};
