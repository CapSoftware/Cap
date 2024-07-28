#[macro_use]
extern crate cfg_if;
extern crate libc;

#[cfg(quartz)] extern crate block;
#[cfg(quartz)] pub mod quartz;

#[cfg(x11)] pub mod x11;

#[cfg(dxgi)] extern crate winapi;
#[cfg(dxgi)] pub mod dxgi;

mod common;
pub use common::*;