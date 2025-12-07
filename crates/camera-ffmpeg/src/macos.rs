use cap_camera::CapturedFrame;
use cap_camera_avfoundation::ImageBufExt;
use cidre::*;

use crate::CapturedFrameExt;

#[derive(thiserror::Error, Debug)]
pub enum AsFFmpegError {
    #[error("Unsupported media subtype '{0}'")]
    UnsupportedSubType(String),
    #[error("Insufficient plane count for format '{format}': expected {expected}, found {found}")]
    InsufficientPlaneCount {
        format: String,
        expected: usize,
        found: usize,
    },
    #[error("{0}")]
    Native(#[from] cidre::os::Error),
}

impl CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let native = self.native().clone();

        let width = native.image_buf().width();
        let height = native.image_buf().height();

        let format_desc = native.sample_buf().format_desc().unwrap();

        let mut this = native.image_buf().clone();

        let bytes_lock =
            ImageBufExt::base_addr_lock(this.as_mut(), cv::pixel_buffer::LockFlags::READ_ONLY)?;

        let res = match cidre::four_cc_to_str(&mut format_desc.media_sub_type().to_be_bytes()) {
            "2vuy" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::UYVY422,
                    width as u32,
                    height as u32,
                );

                let src_stride = native.image_buf().plane_bytes_per_row(0);
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width * 2;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                ff_frame
            }
            "420v" | "420f" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::NV12,
                    width as u32,
                    height as u32,
                );

                let src_stride = native.image_buf().plane_bytes_per_row(0);
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                let src_stride = native.image_buf().plane_bytes_per_row(1);
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
            "yuvs" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::YUYV422,
                    width as u32,
                    height as u32,
                );

                let src_stride = native.image_buf().plane_bytes_per_row(0);
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width * 2;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                ff_frame
            }
            "BGRA" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::BGRA,
                    width as u32,
                    height as u32,
                );

                let src_stride = native.image_buf().plane_bytes_per_row(0);
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
            "ARGB" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::ARGB,
                    width as u32,
                    height as u32,
                );

                let src_stride = native.image_buf().plane_bytes_per_row(0);
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
            "24BG" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::BGR24,
                    width as u32,
                    height as u32,
                );

                let src_stride = native.image_buf().plane_bytes_per_row(0);
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width * 3;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                ff_frame
            }
            "y420" => {
                let plane_count = native.image_buf().plane_count();
                if plane_count < 3 {
                    return Err(AsFFmpegError::InsufficientPlaneCount {
                        format: "y420".to_string(),
                        expected: 3,
                        found: plane_count,
                    });
                }

                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::YUV420P,
                    width as u32,
                    height as u32,
                );

                for plane in 0..3 {
                    let src_stride = native.image_buf().plane_bytes_per_row(plane);
                    let dest_stride = ff_frame.stride(plane);
                    let plane_height = native.image_buf().plane_height(plane);

                    let src_bytes = bytes_lock.plane_data(plane);
                    let dest_bytes = &mut ff_frame.data_mut(plane);

                    let row_width = native.image_buf().plane_width(plane);
                    for y in 0..plane_height {
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];
                        dest_row.copy_from_slice(src_row);
                    }
                }

                ff_frame
            }
            format => {
                return Err(AsFFmpegError::UnsupportedSubType(format.to_string()));
            }
        };

        Ok(res)
    }
}
