#[cfg(target_os = "windows")]
pub mod win;

#[cfg(target_os = "windows")]
pub use win::*;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::*;
