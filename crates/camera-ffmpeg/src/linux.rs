use cap_camera::{CapturedFrame, NativeFrameFormat};
use ffmpeg::{Packet, format::Pixel, frame::Video as FFVideo};
use std::cell::RefCell;

use crate::CapturedFrameExt;

#[derive(thiserror::Error, Debug)]
pub enum AsFFmpegError {
    #[error("Unsupported Linux camera pixel format '{0}'")]
    UnsupportedFormat(String),
    #[error(
        "Invalid camera frame data for {format}: expected at least {expected} bytes, found {actual}"
    )]
    InvalidFrameData {
        format: String,
        expected: usize,
        actual: usize,
    },
    #[error("MJPEG decode error: {0}")]
    MjpegDecodeError(String),
    #[error("Invalid camera frame stride for {format}: {stride}")]
    InvalidFrameStride { format: String, stride: usize },
}

struct MjpegDecoder {
    decoder: ffmpeg::codec::decoder::Video,
}

impl MjpegDecoder {
    fn new() -> Result<Self, AsFFmpegError> {
        let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::MJPEG)
            .ok_or_else(|| AsFFmpegError::MjpegDecodeError("MJPEG codec not found".to_string()))?;

        let decoder_context = ffmpeg::codec::context::Context::new_with_codec(codec);
        let decoder = decoder_context.decoder().video().map_err(|e| {
            AsFFmpegError::MjpegDecodeError(format!("Failed to create decoder: {e}"))
        })?;

        Ok(Self { decoder })
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<FFVideo, AsFFmpegError> {
        let packet = Packet::copy(bytes);
        self.decoder
            .send_packet(&packet)
            .map_err(|e| AsFFmpegError::MjpegDecodeError(format!("Failed to send packet: {e}")))?;

        let mut decoded_frame = FFVideo::empty();
        self.decoder
            .receive_frame(&mut decoded_frame)
            .map_err(|e| {
                AsFFmpegError::MjpegDecodeError(format!("Failed to receive frame: {e}"))
            })?;

        Ok(decoded_frame)
    }
}

thread_local! {
    static MJPEG_DECODER: RefCell<Option<MjpegDecoder>> = const { RefCell::new(None) };
}

fn decode_mjpeg(bytes: &[u8]) -> Result<FFVideo, AsFFmpegError> {
    MJPEG_DECODER.with(|decoder_cell| {
        let mut decoder_opt = decoder_cell.borrow_mut();

        if decoder_opt.is_none() {
            *decoder_opt = Some(MjpegDecoder::new()?);
        }

        decoder_opt.as_mut().unwrap().decode(bytes)
    })
}

impl CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<FFVideo, AsFFmpegError> {
        let native = self.native();
        let format = native.format;
        let bytes = native.bytes.as_slice();

        match fourcc_str(format.fourcc).as_str() {
            "YUYV" => copy_packed(bytes, format, Pixel::YUYV422, 2),
            "UYVY" => copy_packed(bytes, format, Pixel::UYVY422, 2),
            "RGB3" => copy_packed(bytes, format, Pixel::RGB24, 3),
            "BGR3" => copy_packed(bytes, format, Pixel::BGR24, 3),
            "NV12" => copy_nv12(bytes, format),
            "YU12" => copy_yuv420(bytes, format, false),
            "YV12" => copy_yuv420(bytes, format, true),
            "MJPG" | "JPEG" => decode_mjpeg(bytes),
            other => Err(AsFFmpegError::UnsupportedFormat(other.to_string())),
        }
    }
}

fn copy_packed(
    bytes: &[u8],
    format: NativeFrameFormat,
    pixel: Pixel,
    bytes_per_pixel: usize,
) -> Result<FFVideo, AsFFmpegError> {
    let width = format.width as usize;
    let height = format.height as usize;
    let row_width = width * bytes_per_pixel;
    let source_stride = format.stride.max(row_width);
    require_len(bytes, source_stride * height, format)?;

    let mut frame = FFVideo::new(pixel, format.width, format.height);
    let dest_stride = frame.stride(0);
    let dest = frame.data_mut(0);

    for y in 0..height {
        let source_start = y * source_stride;
        let source_end = source_start + row_width;
        let dest_start = y * dest_stride;
        dest[dest_start..dest_start + row_width].copy_from_slice(&bytes[source_start..source_end]);
    }

    Ok(frame)
}

fn copy_nv12(bytes: &[u8], format: NativeFrameFormat) -> Result<FFVideo, AsFFmpegError> {
    let width = format.width as usize;
    let height = format.height as usize;
    let source_stride = format.stride.max(width);
    let y_size = source_stride * height;
    let uv_height = height / 2;
    require_len(bytes, y_size + source_stride * uv_height, format)?;

    let mut frame = FFVideo::new(Pixel::NV12, format.width, format.height);
    let y_dest_stride = frame.stride(0);
    copy_plane(
        bytes,
        0,
        source_stride,
        frame.data_mut(0),
        y_dest_stride,
        width,
        height,
    );
    let uv_dest_stride = frame.stride(1);
    copy_plane(
        bytes,
        y_size,
        source_stride,
        frame.data_mut(1),
        uv_dest_stride,
        width,
        uv_height,
    );

    Ok(frame)
}

fn copy_yuv420(
    bytes: &[u8],
    format: NativeFrameFormat,
    v_before_u: bool,
) -> Result<FFVideo, AsFFmpegError> {
    let width = format.width as usize;
    let height = format.height as usize;
    let y_stride = format.stride.max(width);
    let chroma_width = width / 2;
    let chroma_height = height / 2;
    if y_stride % 2 != 0 {
        return Err(AsFFmpegError::InvalidFrameStride {
            format: fourcc_str(format.fourcc),
            stride: y_stride,
        });
    }
    let chroma_stride = y_stride / 2;
    let y_size = y_stride * height;
    let chroma_size = chroma_stride * chroma_height;
    require_len(bytes, y_size + chroma_size * 2, format)?;

    let mut frame = FFVideo::new(Pixel::YUV420P, format.width, format.height);
    let y_dest_stride = frame.stride(0);
    copy_plane(
        bytes,
        0,
        y_stride,
        frame.data_mut(0),
        y_dest_stride,
        width,
        height,
    );

    let first_chroma_plane = if v_before_u { 2 } else { 1 };
    let second_chroma_plane = if v_before_u { 1 } else { 2 };

    let first_chroma_stride = frame.stride(first_chroma_plane);
    copy_plane(
        bytes,
        y_size,
        chroma_stride,
        frame.data_mut(first_chroma_plane),
        first_chroma_stride,
        chroma_width,
        chroma_height,
    );
    let second_chroma_stride = frame.stride(second_chroma_plane);
    copy_plane(
        bytes,
        y_size + chroma_size,
        chroma_stride,
        frame.data_mut(second_chroma_plane),
        second_chroma_stride,
        chroma_width,
        chroma_height,
    );

    Ok(frame)
}

fn copy_plane(
    source: &[u8],
    source_offset: usize,
    source_stride: usize,
    dest: &mut [u8],
    dest_stride: usize,
    row_width: usize,
    height: usize,
) {
    for y in 0..height {
        let source_start = source_offset + y * source_stride;
        let dest_start = y * dest_stride;
        dest[dest_start..dest_start + row_width]
            .copy_from_slice(&source[source_start..source_start + row_width]);
    }
}

fn require_len(
    bytes: &[u8],
    expected: usize,
    format: NativeFrameFormat,
) -> Result<(), AsFFmpegError> {
    if bytes.len() < expected {
        return Err(AsFFmpegError::InvalidFrameData {
            format: fourcc_str(format.fourcc),
            expected,
            actual: bytes.len(),
        });
    }

    Ok(())
}

fn fourcc_str(fourcc: [u8; 4]) -> String {
    String::from_utf8_lossy(&fourcc).to_string()
}
