mod bgra_rgba;
mod nv12_rgba;
mod util;
mod uyvy;
mod uyvy_nv12;
mod uyvy_rgba;
mod yuyv;
mod yuyv_nv12;
mod yuyv_rgba;

pub use bgra_rgba::BGRAToRGBA;
pub use nv12_rgba::NV12ToRGBA;
pub use uyvy_nv12::UYVYToNV12;
pub use uyvy_rgba::UYVYToRGBA;
pub use yuyv_nv12::YUYVToNV12;
pub use yuyv_rgba::YUYVToRGBA;

#[derive(Debug, thiserror::Error)]
pub enum GpuConverterError {
    #[error("Failed to request GPU adapter: {0}")]
    RequestAdapterFailed(#[from] wgpu::RequestAdapterError),
    #[error("Failed to request GPU device: {0}")]
    RequestDeviceFailed(#[from] wgpu::RequestDeviceError),
}

#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error("YUYV format requires even width, got {width}")]
    OddWidth { width: u32 },
    #[error("buffer size mismatch: expected {expected} bytes, got {actual}")]
    BufferSizeMismatch { expected: usize, actual: usize },
    #[error("failed to create input texture: {0}")]
    TextureCreation(String),
    #[error("GPU poll error: {0}")]
    Poll(#[from] wgpu::PollError),
}

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
