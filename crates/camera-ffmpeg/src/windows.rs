use cap_camera::CapturedFrame;
use cap_camera_windows::PixelFormat;
use ffmpeg::{format::Pixel, frame::Video as FFVideo};

use crate::CapturedFrameExt;

#[derive(thiserror::Error, Debug)]
pub enum AsFFmpegError {
    #[error("FailedToGetBytes: {0}")]
    FailedToGetBytes(windows_core::Error),
    #[error("Empty")]
    Empty,
}

impl CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let native = self.native();
        let width = native.width;
        let height = native.height;

        if width == 0 || height == 0 {
            return Err(AsFFmpegError::Empty);
        }

        let bytes = native.bytes().map_err(AsFFmpegError::FailedToGetBytes)?;

        if bytes.len() == 0 {
            return Err(AsFFmpegError::Empty);
        }

        Ok(match native.pixel_format {
            PixelFormat::YUV420P => {
                let mut ff_frame = FFVideo::new(Pixel::YUV420P, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width;
                    let src_row = &bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let stride = ff_frame.stride(1);

                for y in 0..height / 2 {
                    let row_width = width / 2;
                    let src_row = &bytes[width * height + y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let stride = ff_frame.stride(2);

                for y in 0..height / 2 {
                    let row_width = width / 2;
                    let src_row = &bytes[width * height + width * height / 4 + y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(2)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::NV12 => {
                let mut ff_frame = FFVideo::new(Pixel::NV12, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let src_row = &bytes[y * width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..width].copy_from_slice(&src_row[0..width]);
                }

                let stride = ff_frame.stride(1);
                let src_row = &bytes[width * height..];

                for y in 0..height / 2 {
                    let row_width = width;
                    let src_row = &src_row[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::ARGB => {
                let mut ff_frame = FFVideo::new(
                    // ik it's weird but that's how windows works
                    Pixel::BGRA,
                    width as u32,
                    height as u32,
                );

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &bytes[(height - y - 1) * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::RGB24 => {
                let mut ff_frame = FFVideo::new(Pixel::RGB24, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::RGB32 => {
                let mut ff_frame = FFVideo::new(Pixel::RGB32, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &bytes[(height - y - 1) * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::YUYV422 => {
                let mut ff_frame = FFVideo::new(Pixel::YUYV422, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 2;
                    let src_row = &bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::UYVY422 => {
                let mut ff_frame = FFVideo::new(Pixel::UYVY422, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 2;
                    let src_row = &bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
        })
    }
}
