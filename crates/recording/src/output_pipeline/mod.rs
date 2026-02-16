mod async_camera;
mod core;
pub mod ffmpeg;
#[cfg(target_os = "macos")]
mod macos_fragmented_m4s;

pub use async_camera::*;
pub use core::*;
pub use ffmpeg::*;
#[cfg(target_os = "macos")]
pub use macos_fragmented_m4s::*;

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

#[cfg(windows)]
mod win_fragmented_m4s;
#[cfg(windows)]
pub use win_fragmented_m4s::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
