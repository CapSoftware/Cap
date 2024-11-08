mod nv12_rgba;
mod util;
mod uyvy;
mod uyvy_nv12;
mod uyvy_rgba;

pub use nv12_rgba::NV12ToRGBA;
pub use uyvy_nv12::UYVYToNV12;
pub use uyvy_rgba::UYVYToRGBA;

pub struct NV12Input<'a> {
    y_data: &'a [u8],
    uv_data: &'a [u8],
}

impl<'a> NV12Input<'a> {
    pub fn from_buffer(buffer: &'a [u8], width: u32, height: u32) -> Self {
        Self {
            y_data: &buffer[..(width * height) as usize],
            uv_data: &buffer[(width * height) as usize..],
        }
    }
}
