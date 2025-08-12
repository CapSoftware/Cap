#![cfg(target_os = "macos")]

mod capture;
mod config;
mod targets;

pub use capture::{Capturer, CapturerBuilder};
pub use config::StreamCfgBuilder;
pub use targets::{Display, Window};
