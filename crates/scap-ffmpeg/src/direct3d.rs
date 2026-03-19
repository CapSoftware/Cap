use ffmpeg::format::Pixel;
use scap_direct3d::PixelFormat;

pub type AsFFmpegError = windows::core::Error;

#[inline]
fn copy_frame_data(
    src_bytes: &[u8],
    src_stride: usize,
    dest_bytes: &mut [u8],
    dest_stride: usize,
    row_length: usize,
    height: usize,
) {
    debug_assert!(height > 0, "height must be positive");
    debug_assert!(
        src_bytes.len()
            >= (height - 1)
                .saturating_mul(src_stride)
                .saturating_add(row_length),
        "source buffer too small"
    );
    debug_assert!(
        dest_bytes.len()
            >= (height - 1)
                .saturating_mul(dest_stride)
                .saturating_add(row_length),
        "destination buffer too small"
    );

    if src_stride == row_length && dest_stride == row_length {
        let total_bytes = row_length.saturating_mul(height);
        unsafe {
            std::ptr::copy_nonoverlapping(src_bytes.as_ptr(), dest_bytes.as_mut_ptr(), total_bytes);
        }
    } else {
        for i in 0..height {
            unsafe {
                std::ptr::copy_nonoverlapping(
                    src_bytes.as_ptr().add(i * src_stride),
                    dest_bytes.as_mut_ptr().add(i * dest_stride),
                    row_length,
                );
            }
        }
    }
}

impl super::AsFFmpeg for scap_direct3d::Frame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let buffer = self.as_buffer()?;

        let width = self.width() as usize;
        let height = self.height() as usize;

        let src_bytes = buffer.data();
        let src_stride = buffer.stride() as usize;
        let row_length = width * 4;

        match self.pixel_format() {
            PixelFormat::R8G8B8A8Unorm => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::RGBA,
                    self.width(),
                    self.height(),
                );

                let dest_stride = ff_frame.stride(0);
                let dest_bytes = ff_frame.data_mut(0);

                copy_frame_data(
                    src_bytes,
                    src_stride,
                    dest_bytes,
                    dest_stride,
                    row_length,
                    height,
                );

                Ok(ff_frame)
            }
            PixelFormat::B8G8R8A8Unorm => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::BGRA,
                    self.width(),
                    self.height(),
                );

                let dest_stride = ff_frame.stride(0);
                let dest_bytes = ff_frame.data_mut(0);

                copy_frame_data(
                    src_bytes,
                    src_stride,
                    dest_bytes,
                    dest_stride,
                    row_length,
                    height,
                );

                Ok(ff_frame)
            }
        }
    }
}

pub trait PixelFormatExt {
    fn as_ffmpeg(&self) -> Pixel;
}

impl PixelFormatExt for PixelFormat {
    fn as_ffmpeg(&self) -> Pixel {
        match self {
            PixelFormat::R8G8B8A8Unorm => Pixel::RGBA,
            PixelFormat::B8G8R8A8Unorm => Pixel::BGRA,
        }
    }
}
