pub use ffmpeg::format::{
    pixel::Pixel,
    sample::{Sample, Type},
};
pub use ffmpeg::util::{
    channel_layout::ChannelLayout,
    frame::{Audio as FFAudio, Frame as FFFrame, Video as FFVideo},
    rational::Rational as FFRational,
};
pub use ffmpeg::{Error as FFError, Packet as FFPacket, error::EAGAIN};

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
