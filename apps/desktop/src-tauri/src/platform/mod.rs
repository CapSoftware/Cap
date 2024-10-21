#[cfg(target_os = "windows")]
mod win;

#[cfg(target_os = "windows")]
pub use win::*;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::*;
