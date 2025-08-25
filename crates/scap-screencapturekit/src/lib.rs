#![cfg(target_os = "macos")]

mod capture;
mod config;

pub use capture::{AudioFrame, Capturer, CapturerBuilder, Frame, VideoFrame};
pub use config::StreamCfgBuilder;
