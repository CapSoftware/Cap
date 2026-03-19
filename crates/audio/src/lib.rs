mod audio_data;
mod calibration_store;
mod latency;
mod renderer;
mod sync_analysis;

pub use audio_data::*;
pub use calibration_store::*;
pub use latency::*;
pub use renderer::*;
pub use sync_analysis::*;

pub trait FromSampleBytes: cpal::SizedSample + std::fmt::Debug + Send + 'static {
    const BYTE_SIZE: usize;

    fn from_bytes(bytes: &[u8]) -> Self;
}

macro_rules! sample_bytes {
    ( $( $num:ty, $size:literal ),* ) => (
        $(
            impl FromSampleBytes for $num {
                const BYTE_SIZE: usize = $size;

                fn from_bytes(bytes: &[u8]) -> Self {
                    Self::from_le_bytes(bytes.try_into().expect("Incorrect byte slice length"))
                }
            }
        )*
    )
}

sample_bytes!(u8, 1, i16, 2, i32, 4, i64, 8, f32, 4, f64, 8);

/// # Safety
/// The input slice must be aligned to the size of `f32`.
pub unsafe fn cast_f32_slice_to_bytes(slice: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(slice.as_ptr() as *const u8, slice.len() * f32::BYTE_SIZE) }
}

/// # Safety
/// The input slice must be aligned to the size of `f32`.
pub unsafe fn cast_bytes_to_f32_slice(slice: &[u8]) -> &[f32] {
    unsafe {
        std::slice::from_raw_parts(slice.as_ptr() as *const f32, slice.len() / f32::BYTE_SIZE)
    }
}
