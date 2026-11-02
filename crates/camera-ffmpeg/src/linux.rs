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

impl CapturedFrameExt for CapturedFrame<'_> {
    fn as_ffmpeg(&self) -> Result<FFVideo, AsFFmpegError> {
        let native = self.native();
        frame_from_bytes(native.bytes, native.format)
    }
}

fn frame_from_bytes(bytes: &[u8], format: NativeFrameFormat) -> Result<FFVideo, AsFFmpegError> {
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

const FRAME_POOL_CAPACITY: usize = 4;

struct FramePool {
    frames: Vec<FFVideo>,
}

thread_local! {
    static FRAME_POOL: RefCell<FramePool> = const { RefCell::new(FramePool { frames: Vec::new() }) };
}

fn with_pooled_frame(
    pixel: Pixel,
    width: u32,
    height: u32,
    fill: impl FnOnce(&mut FFVideo) -> Result<(), AsFFmpegError>,
) -> Result<FFVideo, AsFFmpegError> {
    FRAME_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let index = if let Some(index) = matching_reusable(&pool.frames, pixel, width, height) {
            index
        } else if let Some(index) = pool.frames.iter().position(frame_is_reusable) {
            pool.frames[index] = FFVideo::new(pixel, width, height);
            index
        } else if pool.frames.len() < FRAME_POOL_CAPACITY {
            pool.frames.push(FFVideo::new(pixel, width, height));
            pool.frames.len() - 1
        } else {
            let mut frame = FFVideo::new(pixel, width, height);
            fill(&mut frame)?;
            return Ok(frame);
        };
        fill(&mut pool.frames[index])?;
        Ok(reference_frame(&pool.frames[index]))
    })
}

fn matching_reusable(frames: &[FFVideo], pixel: Pixel, width: u32, height: u32) -> Option<usize> {
    frames.iter().position(|frame| {
        frame.format() == pixel
            && frame.width() == width
            && frame.height() == height
            && frame_is_reusable(frame)
    })
}

fn frame_is_reusable(frame: &FFVideo) -> bool {
    // av_frame_ref hands this buffer to the feed. It can be filled again only
    // after those references are gone, or a live frame would change underneath.
    unsafe { ffmpeg::ffi::av_frame_is_writable(frame.as_ptr().cast_mut()) != 0 }
}

fn reference_frame(frame: &FFVideo) -> FFVideo {
    let mut referenced = FFVideo::empty();
    let status = unsafe { ffmpeg::ffi::av_frame_ref(referenced.as_mut_ptr(), frame.as_ptr()) };
    if status < 0 {
        return frame.clone();
    }
    referenced
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

    with_pooled_frame(pixel, format.width, format.height, |frame| {
        let dest_stride = frame.stride(0);
        let dest = frame.data_mut(0);
        for y in 0..height {
            let source_start = y * source_stride;
            let source_end = source_start + row_width;
            let dest_start = y * dest_stride;
            dest[dest_start..dest_start + row_width]
                .copy_from_slice(&bytes[source_start..source_end]);
        }
        Ok(())
    })
}

fn copy_nv12(bytes: &[u8], format: NativeFrameFormat) -> Result<FFVideo, AsFFmpegError> {
    let width = format.width as usize;
    let height = format.height as usize;
    let source_stride = format.stride.max(width);
    let y_size = source_stride * height;
    let uv_height = height / 2;
    require_len(bytes, y_size + source_stride * uv_height, format)?;

    with_pooled_frame(Pixel::NV12, format.width, format.height, |frame| {
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
        Ok(())
    })
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

    let first_chroma_plane = if v_before_u { 2 } else { 1 };
    let second_chroma_plane = if v_before_u { 1 } else { 2 };

    with_pooled_frame(Pixel::YUV420P, format.width, format.height, |frame| {
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
        Ok(())
    })
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

#[cfg(test)]
mod tests {
    use super::{AsFFmpegError, copy_nv12, copy_packed, frame_from_bytes};
    use cap_camera::NativeFrameFormat;
    use ffmpeg::format::Pixel;

    fn format(fourcc: &[u8; 4], width: u32, height: u32, stride: usize) -> NativeFrameFormat {
        NativeFrameFormat {
            fourcc: *fourcc,
            width,
            height,
            stride,
        }
    }

    fn active_rows(frame: &ffmpeg::frame::Video, plane: usize, row_width: usize) -> Vec<u8> {
        let stride = frame.stride(plane);
        let height = frame.plane_height(plane) as usize;
        let data = frame.data(plane);
        let mut rows = Vec::with_capacity(height * row_width);
        for y in 0..height {
            let start = y * stride;
            rows.extend_from_slice(&data[start..start + row_width]);
        }
        rows
    }

    #[test]
    fn packed_yuyv_keeps_rows_and_drops_source_padding() {
        let _ = ffmpeg::init();
        let source = [1, 2, 3, 4, 9, 9, 5, 6, 7, 8, 8, 8];
        let frame = copy_packed(&source, format(b"YUYV", 2, 2, 6), Pixel::YUYV422, 2).unwrap();
        assert_eq!(frame.format(), Pixel::YUYV422);
        assert_eq!(frame.width(), 2);
        assert_eq!(frame.height(), 2);
        assert_eq!(active_rows(&frame, 0, 4), vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn nv12_copies_y_and_interleaved_chroma() {
        let _ = ffmpeg::init();
        let source = [1, 2, 3, 4, 5, 6];
        let frame = copy_nv12(&source, format(b"NV12", 2, 2, 2)).unwrap();
        assert_eq!(active_rows(&frame, 0, 2), vec![1, 2, 3, 4]);
        assert_eq!(active_rows(&frame, 1, 2), vec![5, 6]);
    }

    #[test]
    fn yv12_stores_v_before_u() {
        let _ = ffmpeg::init();
        let source = [1, 2, 3, 4, 9, 8];
        let yv12 = frame_from_bytes(&source, format(b"YV12", 2, 2, 2)).unwrap();
        let yu12 = frame_from_bytes(&source, format(b"YU12", 2, 2, 2)).unwrap();
        assert_eq!(active_rows(&yv12, 0, 2), vec![1, 2, 3, 4]);
        assert_eq!(active_rows(&yv12, 1, 1), vec![8]);
        assert_eq!(active_rows(&yv12, 2, 1), vec![9]);
        assert_eq!(active_rows(&yu12, 1, 1), vec![9]);
        assert_eq!(active_rows(&yu12, 2, 1), vec![8]);
    }

    #[test]
    fn a_live_frame_keeps_its_pixels_when_the_next_one_is_filled() {
        let _ = ffmpeg::init();
        let first =
            copy_packed(&[1, 2, 3, 4], format(b"YUYV", 2, 1, 4), Pixel::YUYV422, 2).unwrap();
        let second =
            copy_packed(&[5, 6, 7, 8], format(b"YUYV", 2, 1, 4), Pixel::YUYV422, 2).unwrap();
        assert_eq!(active_rows(&first, 0, 4), vec![1, 2, 3, 4]);
        assert_eq!(active_rows(&second, 0, 4), vec![5, 6, 7, 8]);
        drop(first);
        let third = copy_packed(
            &[9, 10, 11, 12],
            format(b"YUYV", 2, 1, 4),
            Pixel::YUYV422,
            2,
        )
        .unwrap();
        assert_eq!(active_rows(&third, 0, 4), vec![9, 10, 11, 12]);
        assert_eq!(active_rows(&second, 0, 4), vec![5, 6, 7, 8]);
    }

    #[test]
    fn short_and_odd_frames_keep_their_errors() {
        let _ = ffmpeg::init();
        let short = copy_packed(&[1], format(b"YUYV", 2, 1, 4), Pixel::YUYV422, 2);
        assert!(matches!(short, Err(AsFFmpegError::InvalidFrameData { .. })));
        let odd = frame_from_bytes(&[1, 2, 3, 4, 5, 6], format(b"YU12", 2, 2, 3));
        assert!(matches!(odd, Err(AsFFmpegError::InvalidFrameStride { .. })));
        let unsupported = frame_from_bytes(&[], format(b"XXXX", 1, 1, 1));
        assert!(matches!(
            unsupported,
            Err(AsFFmpegError::UnsupportedFormat(_))
        ));
    }
}
