#![cfg(target_os = "macos")]

mod capture;
mod config;
mod permission;

pub use capture::{AudioFrame, Capturer, CapturerBuilder, Frame, VideoFrame};
pub use config::StreamCfgBuilder;
pub use permission::{has_permission, request_permission};

/// Check if system audio capture is supported on the current macOS version.
/// System audio capture via ScreenCaptureKit requires macOS 13.0 or later.
pub fn is_system_audio_supported() -> bool {
    cidre::api::macos_available("13.0")
}
