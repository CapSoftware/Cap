use std::{cell::RefCell, collections::VecDeque};

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
    #[error("H264 decode error: {0}")]
    H264DecodeError(String),
    #[error("H264 decoder needs more data (non-fatal)")]
    H264NeedMoreData,
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

pub struct H264Decoder {
    decoder: ffmpeg::codec::decoder::Video,
    received_keyframe: bool,
    frame_buffer: VecDeque<FFVideo>,
}

impl H264Decoder {
    pub fn new() -> Result<Self, AsFFmpegError> {
        let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::H264)
            .ok_or_else(|| AsFFmpegError::H264DecodeError("H264 codec not found".to_string()))?;

        let decoder_context = ffmpeg::codec::context::Context::new_with_codec(codec);

        let decoder = decoder_context.decoder().video().map_err(|e| {
            AsFFmpegError::H264DecodeError(format!("Failed to create decoder: {e}"))
        })?;

        Ok(Self {
            decoder,
            received_keyframe: false,
            frame_buffer: VecDeque::new(),
        })
    }

    pub fn decode(&mut self, bytes: &[u8]) -> Result<Option<FFVideo>, AsFFmpegError> {
        if let Some(frame) = self.frame_buffer.pop_front() {
            return Ok(Some(frame));
        }

        if !self.received_keyframe && !Self::contains_keyframe(bytes) {
            return Ok(None);
        }

        if Self::contains_keyframe(bytes) {
            self.received_keyframe = true;
        }

        let packet = Packet::copy(bytes);

        loop {
            match self.decoder.send_packet(&packet) {
                Ok(()) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => {
                    self.drain_frames()?;
                }
                Err(e) => {
                    return Err(AsFFmpegError::H264DecodeError(format!(
                        "Failed to send packet: {e}"
                    )));
                }
            }
        }

        self.drain_frames()?;

        Ok(self.frame_buffer.pop_front())
    }

    pub fn flush(&mut self) -> Result<Vec<FFVideo>, AsFFmpegError> {
        if let Err(e) = self.decoder.send_eof()
            && !matches!(e, ffmpeg::Error::Eof)
        {
            return Err(AsFFmpegError::H264DecodeError(format!(
                "Failed to send EOF: {e}"
            )));
        }

        self.drain_frames()?;

        Ok(self.frame_buffer.drain(..).collect())
    }

    pub fn reset(&mut self) -> Result<(), AsFFmpegError> {
        *self = Self::new()?;
        Ok(())
    }

    fn drain_frames(&mut self) -> Result<(), AsFFmpegError> {
        loop {
            let mut decoded_frame = FFVideo::empty();
            match self.decoder.receive_frame(&mut decoded_frame) {
                Ok(()) => {
                    self.frame_buffer.push_back(decoded_frame);
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => {
                    return Ok(());
                }
                Err(ffmpeg::Error::Eof) => {
                    return Ok(());
                }
                Err(e) => {
                    return Err(AsFFmpegError::H264DecodeError(format!(
                        "Failed to receive frame: {e}"
                    )));
                }
            }
        }
    }

    fn contains_keyframe(bytes: &[u8]) -> bool {
        let mut i = 0;
        while i + 4 < bytes.len() {
            if bytes[i] == 0 && bytes[i + 1] == 0 {
                let (start_code_len, nal_start) = if bytes[i + 2] == 1 {
                    (3, i + 3)
                } else if bytes[i + 2] == 0 && i + 3 < bytes.len() && bytes[i + 3] == 1 {
                    (4, i + 4)
                } else {
                    i += 1;
                    continue;
                };

                if nal_start < bytes.len() {
                    let nal_unit_type = bytes[nal_start] & 0x1F;
                    match nal_unit_type {
                        5 | 7 | 8 => return true,
                        _ => {}
                    }
                }

                i += start_code_len;
            } else {
                i += 1;
            }
        }
        false
    }
}

impl Default for H264Decoder {
    fn default() -> Self {
        Self::new().expect("Failed to create H264Decoder")
    }
}

thread_local! {
    static H264_DECODER: RefCell<Option<H264Decoder>> = const { RefCell::new(None) };
}

fn decode_h264(bytes: &[u8]) -> Result<FFVideo, AsFFmpegError> {
    H264_DECODER.with(|decoder_cell| {
        let mut decoder_opt = decoder_cell.borrow_mut();

        if decoder_opt.is_none() {
            *decoder_opt = Some(H264Decoder::new()?);
        }

        let decoder = decoder_opt.as_mut().unwrap();
        decoder
            .decode(bytes)?
            .ok_or(AsFFmpegError::H264NeedMoreData)
    })
}

pub fn reset_h264_decoder() {
    H264_DECODER.with(|decoder_cell| {
        *decoder_cell.borrow_mut() = None;
    });
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

        if bytes.is_empty() {
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
            PixelFormat::GRAY8 => {
                let mut ff_frame = FFVideo::new(Pixel::GRAY8, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width;
                    let src_row = &bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::GRAY16 => {
                let mut ff_frame = FFVideo::new(Pixel::GRAY16LE, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                let src_stride = width * 2;

                for y in 0..height {
                    let src_row = &bytes[y * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
            PixelFormat::NV21 => {
                let mut ff_frame = FFVideo::new(Pixel::NV12, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let src_row = &bytes[y * width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..width].copy_from_slice(&src_row[0..width]);
                }

                let stride = ff_frame.stride(1);
                let src_uv = &bytes[width * height..];

                for y in 0..height / 2 {
                    let row_width = width;
                    let src_row = &src_uv[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];
                    for x in 0..width / 2 {
                        dest_row[x * 2] = src_row[x * 2 + 1];
                        dest_row[x * 2 + 1] = src_row[x * 2];
                    }
                }

                ff_frame
            }
            PixelFormat::RGB565 => {
                let mut ff_frame = FFVideo::new(Pixel::RGB565LE, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                let src_stride = width * 2;

                for y in 0..height {
                    let src_row = &bytes[(height - y - 1) * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
            PixelFormat::P010 => {
                let mut ff_frame = FFVideo::new(Pixel::P010LE, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                let src_stride = width * 2;

                for y in 0..height {
                    let src_row = &bytes[y * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                let stride = ff_frame.stride(1);
                let uv_offset = width * height * 2;
                let src_stride = width * 2;

                for y in 0..height / 2 {
                    let src_row = &bytes[uv_offset + y * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
            PixelFormat::H264 => decode_h264(&bytes)?,
        })
    }
}
