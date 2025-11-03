#![cfg(target_os = "macos")]

mod capture;
mod config;
mod permission;

pub use capture::{AudioFrame, Capturer, CapturerBuilder, Frame, VideoFrame};
pub use config::StreamCfgBuilder;
pub use permission::{has_permission, request_permission};
