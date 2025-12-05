use cap_camera::CapturedFrame;
use cap_camera_windows::PixelFormat;
use ffmpeg::{Packet, format::Pixel, frame::Video as FFVideo};

use crate::CapturedFrameExt;

#[derive(thiserror::Error, Debug)]
pub enum AsFFmpegError {
    #[error("FailedToGetBytes: {0}")]
    FailedToGetBytes(windows_core::Error),
    #[error("Empty")]
    Empty,
    #[error("MJPEG decode error: {0}")]
    MjpegDecodeError(String),
}

fn decode_mjpeg(bytes: &[u8]) -> Result<FFVideo, AsFFmpegError> {
    let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::MJPEG)
        .ok_or_else(|| AsFFmpegError::MjpegDecodeError("MJPEG codec not found".to_string()))?;

    let decoder_context = ffmpeg::codec::context::Context::new_with_codec(codec);

    let mut decoder = decoder_context
        .decoder()
        .video()
        .map_err(|e| AsFFmpegError::MjpegDecodeError(format!("Failed to create decoder: {e}")))?;

    let packet = Packet::copy(bytes);
    decoder
        .send_packet(&packet)
        .map_err(|e| AsFFmpegError::MjpegDecodeError(format!("Failed to send packet: {e}")))?;

    let mut decoded_frame = FFVideo::empty();
    decoder
        .receive_frame(&mut decoded_frame)
        .map_err(|e| AsFFmpegError::MjpegDecodeError(format!("Failed to receive frame: {e}")))?;

    Ok(decoded_frame)
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
                let mut ff_frame = FFVideo::new(Pixel::BGRA, width as u32, height as u32);

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
                let mut ff_frame = FFVideo::new(Pixel::BGR24, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                let src_stride = width * 3;

                for y in 0..height {
                    let src_row = &bytes[(height - y - 1) * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
            PixelFormat::RGB32 => {
                let mut ff_frame = FFVideo::new(Pixel::BGRA, width as u32, height as u32);

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
            PixelFormat::MJPEG => decode_mjpeg(&bytes)?,
            PixelFormat::YV12 => {
                let mut ff_frame = FFVideo::new(Pixel::YUV420P, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let row_width = width;
                    let src_row = &bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let v_offset = width * height;
                let u_offset = v_offset + (width / 2) * (height / 2);
                let stride_u = ff_frame.stride(1);
                let stride_v = ff_frame.stride(2);

                for y in 0..height / 2 {
                    let row_width = width / 2;
                    let src_v = &bytes[v_offset + y * row_width..];
                    let src_u = &bytes[u_offset + y * row_width..];
                    ff_frame.data_mut(1)[y * stride_u..][0..row_width]
                        .copy_from_slice(&src_u[0..row_width]);
                    ff_frame.data_mut(2)[y * stride_v..][0..row_width]
                        .copy_from_slice(&src_v[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::BGR24 => {
                let mut ff_frame = FFVideo::new(Pixel::BGR24, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                let src_stride = width * 3;

                for y in 0..height {
                    let src_row = &bytes[(height - y - 1) * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
        })
    }
}
