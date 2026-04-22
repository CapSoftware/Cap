use cidre::cv::{self, pixel_buffer::LockFlags};

pub(crate) fn copy_plane_data(
    src: &[u8],
    dest: &mut [u8],
    height: usize,
    row_width: usize,
    src_stride: usize,
    dest_stride: usize,
) {
    if src_stride == row_width && dest_stride == row_width {
        let total_bytes = height * row_width;
        dest[..total_bytes].copy_from_slice(&src[..total_bytes]);
    } else if src_stride == dest_stride {
        let total_bytes = height * src_stride;
        dest[..total_bytes].copy_from_slice(&src[..total_bytes]);
    } else {
        for y in 0..height {
            let src_row = &src[y * src_stride..y * src_stride + row_width];
            let dest_row = &mut dest[y * dest_stride..y * dest_stride + row_width];
            dest_row.copy_from_slice(src_row);
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
