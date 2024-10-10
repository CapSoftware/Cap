#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform_impl;

pub use platform_impl::*;

#[derive(Debug)]
pub struct Bounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug)]
pub struct Window {
    pub window_id: u32,
    pub name: String,
    pub owner_name: String,
    pub process_id: u32,
    pub bounds: Bounds,
}
