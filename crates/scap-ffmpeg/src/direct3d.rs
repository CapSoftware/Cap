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

struct FramePool {
    key: (Pixel, u32, u32),
    linesize: usize,
    pool: *mut ffmpeg::ffi::AVBufferPool,
}

impl Drop for FramePool {
    fn drop(&mut self) {
        // Frees the pool once every buffer still referenced by an in-flight frame is returned.
        unsafe { ffmpeg::ffi::av_buffer_pool_uninit(&mut self.pool) };
    }
}

thread_local! {
    static FRAME_POOL: std::cell::RefCell<Option<FramePool>> = const { std::cell::RefCell::new(None) };
}

// A fresh multi-megabyte allocation per frame is served by fresh OS pages on Windows, so every
// capture paid page-fault and zeroing costs several times the copy itself (~2ms per 1080p frame).
fn pooled_frame(format: Pixel, width: u32, height: u32) -> ffmpeg::frame::Video {
    debug_assert!(matches!(format, Pixel::RGBA | Pixel::BGRA));
    FRAME_POOL.with_borrow_mut(|slot| {
        if slot
            .as_ref()
            .is_none_or(|pool| pool.key != (format, width, height))
        {
            *slot = None;
            let linesize = (width as usize).next_multiple_of(32) * 4;
            let size =
                linesize * height as usize + ffmpeg::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize;
            let pool = unsafe { ffmpeg::ffi::av_buffer_pool_init(size, None) };
            if pool.is_null() {
                return ffmpeg::frame::Video::new(format, width, height);
            }
            *slot = Some(FramePool {
                key: (format, width, height),
                linesize,
                pool,
            });
        }
        let pool = slot.as_ref().expect("frame pool initialized above");
        unsafe {
            let buffer = ffmpeg::ffi::av_buffer_pool_get(pool.pool);
            if buffer.is_null() {
                return ffmpeg::frame::Video::new(format, width, height);
            }
            let mut frame = ffmpeg::frame::Video::empty();
            frame.set_format(format);
            frame.set_width(width);
            frame.set_height(height);
            let raw = frame.as_mut_ptr();
            (*raw).buf[0] = buffer;
            (*raw).data[0] = (*buffer).data;
            (*raw).linesize[0] = pool.linesize as i32;
            frame
        }
    })
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
                let mut ff_frame = pooled_frame(Pixel::RGBA, self.width(), self.height());

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
                let mut ff_frame = pooled_frame(Pixel::BGRA, self.width(), self.height());

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pooled_frames_recycle_released_buffers() {
        let first = pooled_frame(Pixel::BGRA, 1001, 3);
        assert_eq!(
            (first.format(), first.width(), first.height()),
            (Pixel::BGRA, 1001, 3)
        );
        assert!(first.stride(0) >= 1001 * 4);
        assert!(first.data(0).len() >= first.stride(0) * 3);
        let held = first.data(0).as_ptr();

        let second = pooled_frame(Pixel::BGRA, 1001, 3);
        assert_ne!(second.data(0).as_ptr(), held);

        drop(first);
        let third = pooled_frame(Pixel::BGRA, 1001, 3);
        assert_eq!(third.data(0).as_ptr(), held);

        let resized = pooled_frame(Pixel::BGRA, 640, 2);
        assert_eq!((resized.width(), resized.height()), (640, 2));
        drop((second, third));
    }
}
