use cap_camera::CapturedFrame;
use cap_camera_windows::PixelFormat;
use ffmpeg::{format::Pixel, frame::Video as FFVideo};

use crate::CapturedFrameExt;

#[derive(thiserror::Error, Debug)]
pub enum ToFfmpegError {
    #[error("Unsupported media subtype '{0}'")]
    UnsupportedSubType(String),
    #[error("{0}")]
    Native(#[from] cidre::os::Error),
}

impl CapturedFrameExt for CapturedFrame {
    fn to_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ToFfmpegError> {
        let native = self.native();

        let width = native.width();
        let height = native.height();

        let format_desc = native.1.format_desc().unwrap();

        Ok(
            match cidre::four_cc_to_str(&mut format_desc.media_sub_type().to_be_bytes()) {
                "2vuy" => {
                    let mut ff_frame = ffmpeg::frame::Video::new(
                        ffmpeg::format::Pixel::UYVY422,
                        width as u32,
                        height as u32,
                    );

                    let mut this = native.clone();
                    let bytes_lock = ImageBufExt::base_addr_lock(
                        this.as_mut(),
                        cv::pixel_buffer::LockFlags::READ_ONLY,
                    )?;

                    let src_stride = native.plane_bytes_per_row(0);
                    let dest_stride = ff_frame.stride(0);

                    let src_bytes = bytes_lock.plane_data(0);
                    let dest_bytes = &mut ff_frame.data_mut(0);

                    for y in 0..height {
                        let row_width = width * 2;
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                        dest_row.copy_from_slice(src_row);
                    }

                    ff_frame
                }
                "420v" => {
                    let mut ff_frame = ffmpeg::frame::Video::new(
                        ffmpeg::format::Pixel::NV12,
                        width as u32,
                        height as u32,
                    );

                    let mut this = native.clone();
                    let bytes_lock = ImageBufExt::base_addr_lock(
                        this.as_mut(),
                        cv::pixel_buffer::LockFlags::READ_ONLY,
                    )?;

                    let src_stride = native.plane_bytes_per_row(0);
                    let dest_stride = ff_frame.stride(0);

                    let src_bytes = bytes_lock.plane_data(0);
                    let dest_bytes = &mut ff_frame.data_mut(0);

                    for y in 0..height {
                        let row_width = width;
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                        dest_row.copy_from_slice(src_row);
                    }

                    let src_stride = native.plane_bytes_per_row(1);
                    let dest_stride = ff_frame.stride(1);

                    let src_bytes = bytes_lock.plane_data(1);
                    let dest_bytes = &mut ff_frame.data_mut(1);

                    for y in 0..height / 2 {
                        let row_width = width;
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                        dest_row.copy_from_slice(src_row);
                    }

                    ff_frame
                }
                "yuvs" => {
                    let mut ff_frame = ffmpeg::frame::Video::new(
                        ffmpeg::format::Pixel::YUYV422,
                        width as u32,
                        height as u32,
                    );

                    let mut this = native.clone();
                    let bytes_lock = ImageBufExt::base_addr_lock(
                        this.as_mut(),
                        cv::pixel_buffer::LockFlags::READ_ONLY,
                    )?;

                    let src_stride = native.plane_bytes_per_row(0);
                    let dest_stride = ff_frame.stride(0);

                    let src_bytes = bytes_lock.plane_data(0);
                    let dest_bytes = &mut ff_frame.data_mut(0);

                    for y in 0..height {
                        let row_width = width * 2;
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                        dest_row.copy_from_slice(src_row);
                    }

                    ff_frame
                }
                format => {
                    return Err(ToFfmpegError::UnsupportedSubType(format.to_string()));
                }
            },
        )
    }
}
