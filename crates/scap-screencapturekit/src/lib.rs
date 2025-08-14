#![cfg(target_os = "macos")]

mod capture;
mod config;
mod targets;

pub use capture::{AudioFrame, Capturer, CapturerBuilder, Frame, VideoFrame};
pub use config::StreamCfgBuilder;
pub use targets::{Display, Window};
