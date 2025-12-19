mod async_camera;
mod core;
pub mod ffmpeg;
#[cfg(target_os = "macos")]
mod fragmented;
#[cfg(target_os = "macos")]
mod macos_segmented_ffmpeg;

pub use async_camera::*;
pub use core::*;
pub use ffmpeg::*;
#[cfg(target_os = "macos")]
pub use fragmented::*;
#[cfg(target_os = "macos")]
pub use macos_segmented_ffmpeg::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win_segmented;
#[cfg(windows)]
pub use win_segmented::*;

#[cfg(windows)]
mod win_segmented_camera;
#[cfg(windows)]
pub use win_segmented_camera::*;
