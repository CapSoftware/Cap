#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;
