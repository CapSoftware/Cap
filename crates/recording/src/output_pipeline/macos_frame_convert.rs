use cidre::cv::{self, pixel_buffer::LockFlags};

pub(crate) fn copy_plane_data(
    src: &[u8],
    dest: &mut [u8],
    height: usize,
    row_width: usize,
    src_stride: usize,
    dest_stride: usize,
) {
    // A source that grew mid-recording (the pool frame keeps the size the
    // encoder was opened with) is cropped to the frame instead of copied
    // past it; anything that fits copies exactly as before.
    if src_stride == row_width && dest_stride == row_width {
        let total_bytes = height
            .saturating_mul(row_width)
            .min(src.len())
            .min(dest.len());
        dest[..total_bytes].copy_from_slice(&src[..total_bytes]);
    } else if src_stride == dest_stride {
        let total_bytes = height
            .saturating_mul(src_stride)
            .min(src.len())
            .min(dest.len());
        dest[..total_bytes].copy_from_slice(&src[..total_bytes]);
    } else {
        let row_width = row_width.min(src_stride).min(dest_stride);
        for (src_row, dest_row) in src
            .chunks(src_stride.max(1))
            .zip(dest.chunks_mut(dest_stride.max(1)))
            .take(height)
        {
            let len = row_width.min(src_row.len()).min(dest_row.len());
            dest_row[..len].copy_from_slice(&src_row[..len]);
        }
    }
}

pub(crate) struct FramePool {
    frame: Option<ffmpeg::frame::Video>,
    pixel_format: ffmpeg::format::Pixel,
    width: u32,
    height: u32,
}

impl FramePool {
    pub(crate) fn new(pixel_format: ffmpeg::format::Pixel, width: u32, height: u32) -> Self {
        Self {
            frame: Some(ffmpeg::frame::Video::new(pixel_format, width, height)),
            pixel_format,
            width,
            height,
        }
    }

    pub(crate) fn get_frame(&mut self) -> &mut ffmpeg::frame::Video {
        if self.frame.is_none() {
            self.frame = Some(ffmpeg::frame::Video::new(
                self.pixel_format,
                self.width,
                self.height,
            ));
        }
        self.frame.as_mut().expect("frame initialized above")
    }

    pub(crate) fn take_frame(&mut self) -> ffmpeg::frame::Video {
        self.frame.take().unwrap_or_else(|| {
            ffmpeg::frame::Video::new(self.pixel_format, self.width, self.height)
        })
    }
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum SampleBufConversionError {
    UnsupportedFormat(cv::PixelFormat),
    BaseAddrLock(cidre::os::Error),
    NoImageBuffer,
    FormatMismatch {
        source: cv::PixelFormat,
        frame: ffmpeg::format::Pixel,
    },
}

struct BaseAddrLockGuard<'a>(&'a mut cv::ImageBuf, LockFlags);

impl<'a> BaseAddrLockGuard<'a> {
    fn lock(image_buf: &'a mut cv::ImageBuf, flags: LockFlags) -> cidre::os::Result<Self> {
        unsafe { image_buf.lock_base_addr(flags) }.result()?;
        Ok(Self(image_buf, flags))
    }

    fn plane_data(&self, index: usize) -> &[u8] {
        let base_addr = self.0.plane_base_address(index);
        let plane_size = self.0.plane_bytes_per_row(index);
        unsafe { std::slice::from_raw_parts(base_addr, plane_size * self.0.plane_height(index)) }
    }
}

impl Drop for BaseAddrLockGuard<'_> {
    fn drop(&mut self) {
        unsafe { self.0.unlock_lock_base_addr(self.1) };
    }
}

pub(crate) fn fill_frame_from_sample_buf(
    sample_buf: &cidre::cm::SampleBuf,
    frame: &mut ffmpeg::frame::Video,
) -> Result<(), SampleBufConversionError> {
    let Some(image_buf_ref) = sample_buf.image_buf() else {
        return Err(SampleBufConversionError::NoImageBuffer);
    };
    let mut image_buf = image_buf_ref.retained();

    let width = image_buf.width();
    let height = image_buf.height();
    let pixel_format = image_buf.pixel_format();
    let plane0_stride = image_buf.plane_bytes_per_row(0);
    let plane1_stride = image_buf.plane_bytes_per_row(1);

    let expected_format = match pixel_format {
        cv::PixelFormat::_420V => ffmpeg::format::Pixel::NV12,
        cv::PixelFormat::_32_BGRA => ffmpeg::format::Pixel::BGRA,
        cv::PixelFormat::_2VUY => ffmpeg::format::Pixel::UYVY422,
        format => return Err(SampleBufConversionError::UnsupportedFormat(format)),
    };
    if frame.format() != expected_format {
        return Err(SampleBufConversionError::FormatMismatch {
            source: pixel_format,
            frame: frame.format(),
        });
    }

    let bytes_lock = BaseAddrLockGuard::lock(image_buf.as_mut(), LockFlags::READ_ONLY)
        .map_err(SampleBufConversionError::BaseAddrLock)?;

    match pixel_format {
        cv::PixelFormat::_420V => {
            let dest_stride0 = frame.stride(0);
            let dest_stride1 = frame.stride(1);

            copy_plane_data(
                bytes_lock.plane_data(0),
                frame.data_mut(0),
                height,
                width,
                plane0_stride,
                dest_stride0,
            );

            copy_plane_data(
                bytes_lock.plane_data(1),
                frame.data_mut(1),
                height / 2,
                width,
                plane1_stride,
                dest_stride1,
            );
        }
        cv::PixelFormat::_32_BGRA => {
            let row_width = width * 4;
            let dest_stride = frame.stride(0);
            copy_plane_data(
                bytes_lock.plane_data(0),
                frame.data_mut(0),
                height,
                row_width,
                plane0_stride,
                dest_stride,
            );
        }
        cv::PixelFormat::_2VUY => {
            let row_width = width * 2;
            let dest_stride = frame.stride(0);
            copy_plane_data(
                bytes_lock.plane_data(0),
                frame.data_mut(0),
                height,
                row_width,
                plane0_stride,
                dest_stride,
            );
        }
        format => return Err(SampleBufConversionError::UnsupportedFormat(format)),
    }

    Ok(())
}

pub(crate) fn ffmpeg_pixel_format_for_cap(
    cap_pixel: cap_media_info::Pixel,
) -> ffmpeg::format::Pixel {
    match cap_pixel {
        cap_media_info::Pixel::NV12 => ffmpeg::format::Pixel::NV12,
        cap_media_info::Pixel::BGRA => ffmpeg::format::Pixel::BGRA,
        cap_media_info::Pixel::UYVY422 => ffmpeg::format::Pixel::UYVY422,
        _ => ffmpeg::format::Pixel::NV12,
    }
}

#[cfg(test)]
mod tests {
    use super::copy_plane_data;

    fn plane(rows: usize, stride: usize) -> Vec<u8> {
        (0..rows * stride).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn fitting_planes_copy_every_layout_byte_for_byte() {
        for (src_stride, dest_stride) in [(64, 64), (80, 64), (64, 96)] {
            let src = plane(10, src_stride);
            let mut dest = vec![0; 10 * dest_stride];
            copy_plane_data(&src, &mut dest, 10, 64, src_stride, dest_stride);
            for y in 0..10 {
                assert_eq!(
                    dest[y * dest_stride..y * dest_stride + 64],
                    src[y * src_stride..y * src_stride + 64]
                );
            }
        }
    }

    #[test]
    fn a_source_larger_than_the_frame_is_cropped_not_overrun() {
        for (src_stride, dest_stride, row_width) in [
            (128, 128, 128),
            (160, 160, 128),
            (192, 64, 160),
            (64, 64, 200),
        ] {
            let src = plane(40, src_stride);
            let mut dest = vec![0; 10 * dest_stride];
            copy_plane_data(&src, &mut dest, 40, row_width, src_stride, dest_stride);
            let width = row_width.min(src_stride).min(dest_stride);
            assert_eq!(dest[..width], src[..width]);
        }
    }

    #[test]
    fn empty_and_degenerate_planes_do_not_panic() {
        let mut dest = vec![0; 64];
        copy_plane_data(&[], &mut dest, 8, 8, 8, 8);
        copy_plane_data(&plane(8, 8), &mut [], 8, 8, 8, 8);
        copy_plane_data(&plane(8, 8), &mut dest, 8, 8, 0, 16);
        copy_plane_data(&plane(8, 8), &mut dest, usize::MAX / 2, 8, 9, 16);
        copy_plane_data(&plane(8, 8), &mut dest, usize::MAX / 2, 8, 8, 8);
        copy_plane_data(&plane(8, 8), &mut dest, usize::MAX / 2, 4, 8, 8);
    }
}
