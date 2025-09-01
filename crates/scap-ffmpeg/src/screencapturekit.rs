use cidre::{
    cv::{self, pixel_buffer::LockFlags},
    os,
};

#[derive(Debug)]
pub enum AsFFmpegError {
    UnsupportedFormat(cv::PixelFormat),
    BaseAddrLock(os::Error),
}

impl super::AsFFmpeg for scap_screencapturekit::VideoFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let mut image_buf = self.image_buf().retained();

        let width = image_buf.width();
        let height = image_buf.height();

        let bytes_lock =
            ImageBufExt::base_addr_lock(image_buf.as_mut(), cv::pixel_buffer::LockFlags::READ_ONLY)
                .map_err(AsFFmpegError::BaseAddrLock)?;

        Ok(match self.image_buf().pixel_format() {
            cv::PixelFormat::_420V => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::NV12,
                    width as u32,
                    height as u32,
                );

                let src_stride = self.image_buf().plane_bytes_per_row(0);
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                let src_stride = self.image_buf().plane_bytes_per_row(1);
                let dest_stride = ff_frame.stride(1);

                let src_bytes = bytes_lock.plane_data(1);
                let dest_bytes = &mut ff_frame.data_mut(1);

                for y in 0..height / 2 {
                    let row_width = width;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                ff_frame
            }
            cv::PixelFormat::_32_BGRA => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::BGRA,
                    width as u32,
                    height as u32,
                );

                let src_stride = self.image_buf().plane_bytes_per_row(0);
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                ff_frame
            }
            format => return Err(AsFFmpegError::UnsupportedFormat(format)),
        })
    }
}

pub trait ImageBufExt {
    fn base_addr_lock<'a>(
        &'a mut self,
        flags: LockFlags,
    ) -> cidre::os::Result<BaseAddrLockGuard<'a>>;
}

impl ImageBufExt for cv::ImageBuf {
    fn base_addr_lock<'a>(
        &'a mut self,
        flags: LockFlags,
    ) -> cidre::os::Result<BaseAddrLockGuard<'a>> {
        unsafe { self.lock_base_addr(flags) }.result()?;

        Ok(BaseAddrLockGuard(self, flags))
    }
}

pub struct BaseAddrLockGuard<'a>(&'a mut cv::ImageBuf, LockFlags);

impl<'a> BaseAddrLockGuard<'a> {
    pub fn plane_data(&self, index: usize) -> &[u8] {
        let base_addr = self.0.plane_base_address(index);
        let plane_size = self.0.plane_bytes_per_row(index);
        unsafe { std::slice::from_raw_parts(base_addr, plane_size * self.0.plane_height(index)) }
    }
}

impl<'a> Drop for BaseAddrLockGuard<'a> {
    fn drop(&mut self) {
        let _ = unsafe { self.0.unlock_lock_base_addr(self.1) };
    }
}
