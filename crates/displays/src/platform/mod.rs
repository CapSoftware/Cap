#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::DisplayImpl;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::DisplayImpl;
