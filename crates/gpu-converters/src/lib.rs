mod nv12_rgba;
mod yuyv_rgba;

pub use nv12_rgba::NV12ToRGBA;
pub use yuyv_rgba::YUYVToRGBA;

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
