use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform_impl;

#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform_impl;

pub use platform_impl::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug)]
pub struct Window {
    pub window_id: u32,
    pub name: String,
    pub owner_name: String,
    pub process_id: u32,
    pub bounds: Bounds,
}
