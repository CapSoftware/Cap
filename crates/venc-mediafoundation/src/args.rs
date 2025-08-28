use clap::{Parser, Subcommand};

use crate::{resolution::Resolution, video::backend::EncoderBackend};

#[derive(Parser, Debug)]
#[clap(author, version, about, long_about = None)]
pub struct Args {
    /// The index of the display you'd like to record.
    #[clap(short, long, default_value_t = 0)]
    pub display: usize,

    /// The bit rate you would like to encode at (in Mbps).
    #[clap(short, long, default_value_t = 18)]
    pub bit_rate: u32,

    /// The frame rate you would like to encode at.
    #[clap(short, long, default_value_t = 60)]
    pub frame_rate: u32,

    /// The resolution you would like to encode at: native, 720p, 1080p, 2160p, or 4320p.
    #[clap(short, long, default_value_t = Resolution::Native)]
    pub resolution: Resolution,

    /// The index of the encoder you'd like to use to record (use enum-encoders command for a list of encoders and their indices).
    #[clap(short, long, default_value_t = 0)]
    pub encoder: usize,

    /// Disables the yellow capture border (only available on Windows 11).
    #[clap(long)]
    pub borderless: bool,

    /// Enables verbose (debug) output.
    #[clap(short, long)]
    pub verbose: bool,

    /// The program will wait for a debugger to attach before starting.
    #[clap(long)]
    pub wait_for_debugger: bool,

    /// Recording immediately starts. End the recording through console input.
    #[clap(long)]
    pub console_mode: bool,

    /// The backend to use for the video encoder.
    #[clap(long, default_value_t = EncoderBackend::MediaFoundation)]
    pub backend: EncoderBackend,

    /// The output file that will contain the recording.
    #[clap(default_value = "recording.mp4")]
    pub output_file: String,

    /// Subcommands to execute.
    #[clap(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
#[clap(args_conflicts_with_subcommands = true)]
pub enum Commands {
    /// Lists the available hardware H264 encoders.
    EnumEncoders,
}
