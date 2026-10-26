use cap_camera::{CapturedFrame, NativeFrameFormat};
use ffmpeg::{Packet, format::Pixel, frame::Video as FFVideo};
use std::cell::RefCell;

use crate::CapturedFrameExt;
use crate::mjpeg_idct::idct_lowres;

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
    lowres: i32,
}

impl MjpegDecoder {
    fn new(lowres: i32) -> Result<Self, AsFFmpegError> {
        let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::MJPEG)
            .ok_or_else(|| AsFFmpegError::MjpegDecodeError("MJPEG codec not found".to_string()))?;
        let max_lowres = codec.max_lowres().clamp(0, 3);
        let lowres = lowres.clamp(0, max_lowres);

        let mut decoder_context = ffmpeg::codec::context::Context::new_with_codec(codec);
        if lowres > 0 {
            unsafe {
                (*decoder_context.as_mut_ptr()).lowres = lowres;
            }
        }
        let decoder = decoder_context.decoder().video().map_err(|e| {
            AsFFmpegError::MjpegDecodeError(format!("Failed to create decoder: {e}"))
        })?;

        Ok(Self { decoder, lowres })
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

fn decode_mjpeg(bytes: &[u8], lowres: i32) -> Result<FFVideo, AsFFmpegError> {
    MJPEG_DECODER.with(|decoder_cell| {
        let mut slot = decoder_cell.borrow_mut();
        if slot.as_ref().is_none_or(|decoder| decoder.lowres != lowres) {
            tracing::debug!(lowres, "MJPEG IDCT scale");
            *slot = Some(MjpegDecoder::new(lowres)?);
        }
        slot.as_mut()
            .expect("MJPEG decoder is inserted before use")
            .decode(bytes)
    })
}

fn mjpeg_frame_covering(
    bytes: &[u8],
    source_width: u32,
    source_height: u32,
    max_width: u32,
    max_height: u32,
) -> Result<FFVideo, AsFFmpegError> {
    let lowres = idct_lowres(source_width, source_height, max_width, max_height);
    if lowres == 0 {
        return decode_mjpeg(bytes, 0);
    }
    match decode_mjpeg(bytes, lowres) {
        Ok(frame) if frame.width() >= max_width && frame.height() >= max_height => Ok(frame),
        _ => decode_mjpeg(bytes, 0),
    }
}

impl CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<FFVideo, AsFFmpegError> {
        frame_from_native(self, None)
    }

    fn as_ffmpeg_covering(
        &self,
        max_width: u32,
        max_height: u32,
    ) -> Result<FFVideo, AsFFmpegError> {
        frame_from_native(self, Some((max_width, max_height)))
    }
}

fn frame_from_native(
    frame: &CapturedFrame,
    cover: Option<(u32, u32)>,
) -> Result<FFVideo, AsFFmpegError> {
    let native = frame.native();
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
        "MJPG" | "JPEG" => match cover {
            Some((max_width, max_height)) => {
                mjpeg_frame_covering(bytes, format.width, format.height, max_width, max_height)
            }
            None => decode_mjpeg(bytes, 0),
        },
        other => Err(AsFFmpegError::UnsupportedFormat(other.to_string())),
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

#[cfg(test)]
mod tests {
    use super::{MjpegDecoder, decode_mjpeg, mjpeg_frame_covering};
    use crate::mjpeg_idct::idct_lowres;
    use ffmpeg::Packet;
    use ffmpeg::format::Pixel;
    use ffmpeg::frame::Video as FFVideo;

    fn encode_mjpeg(width: u32, height: u32) -> Vec<u8> {
        let codec = ffmpeg::codec::encoder::find(ffmpeg::codec::Id::MJPEG).unwrap();
        let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .unwrap();
        encoder.set_width(width);
        encoder.set_height(height);
        encoder.set_format(Pixel::YUVJ420P);
        encoder.set_time_base((1, 30));
        encoder.set_qmin(4);
        encoder.set_qmax(4);
        let mut encoder = encoder.open().unwrap();

        let mut frame = FFVideo::new(Pixel::YUVJ420P, width, height);
        let luma_stride = frame.stride(0);
        let luma = frame.data_mut(0);
        for y in 0..height as usize {
            for x in 0..width as usize {
                let nx = x as f32 / width as f32;
                let ny = y as f32 / height as f32;
                let value = 70.0
                    + 40.0 * (nx * std::f32::consts::TAU * 2.0).sin()
                    + 25.0 * (ny * std::f32::consts::TAU * 3.0).sin()
                    + 18.0 * ((nx + ny) * std::f32::consts::TAU * 5.0).sin()
                    + ((x * 13 + y * 7) & 7) as f32
                    - 3.0;
                luma[y * luma_stride + x] = value.clamp(0.0, 255.0) as u8;
            }
        }
        frame.data_mut(1).fill(110);
        frame.data_mut(2).fill(150);
        frame.set_pts(Some(0));
        encoder.send_frame(&frame).unwrap();
        encoder.send_eof().unwrap();
        let mut packet = Packet::empty();
        encoder.receive_packet(&mut packet).unwrap();
        packet.data().unwrap().to_vec()
    }

    fn scale_bgra(frame: &FFVideo, width: u32, height: u32) -> FFVideo {
        let mut scaler = ffmpeg::software::scaling::Context::get(
            frame.format(),
            frame.width(),
            frame.height(),
            Pixel::BGRA,
            width,
            height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )
        .unwrap();
        let mut output = FFVideo::empty();
        scaler.run(frame, &mut output).unwrap();
        output
    }

    fn bgra_delta(full: &FFVideo, scaled: &FFVideo) -> (f64, u8) {
        let width = full.width().min(scaled.width()) as usize;
        let height = full.height().min(scaled.height()) as usize;
        let mut sum = 0u64;
        let mut max = 0u8;
        let mut count = 0u64;
        for y in 0..height {
            let full_row = &full.data(0)[y * full.stride(0)..];
            let scaled_row = &scaled.data(0)[y * scaled.stride(0)..];
            for x in 0..width {
                for channel in 0..3 {
                    let delta = full_row[x * 4 + channel].abs_diff(scaled_row[x * 4 + channel]);
                    sum += u64::from(delta);
                    max = max.max(delta);
                    count += 1;
                }
            }
        }
        ((sum as f64) / count.max(1) as f64, max)
    }

    #[test]
    fn scaled_idct_covers_the_bubble_and_stays_close_to_full_then_scale() {
        ffmpeg::init().unwrap();
        let bytes = encode_mjpeg(640, 360);
        let scaled = mjpeg_frame_covering(&bytes, 640, 360, 200, 120).unwrap();
        assert_eq!((scaled.width(), scaled.height()), (320, 180));
        let full = decode_mjpeg(&bytes, 0).unwrap();
        assert_eq!((full.width(), full.height()), (640, 360));
        let (mean, max) = bgra_delta(&scale_bgra(&full, 200, 120), &scale_bgra(&scaled, 200, 120));
        assert!(
            max <= 6 && mean <= 1.5,
            "scaled IDCT vs full decode + scale: mean {mean:.3} max {max}"
        );
    }

    #[test]
    fn full_resolution_request_restores_the_decoder_after_a_scaled_frame() {
        ffmpeg::init().unwrap();
        let bytes = encode_mjpeg(640, 360);
        let scaled = mjpeg_frame_covering(&bytes, 640, 360, 200, 120).unwrap();
        assert_eq!((scaled.width(), scaled.height()), (320, 180));
        let full = mjpeg_frame_covering(&bytes, 640, 360, 640, 360).unwrap();
        assert_eq!((full.width(), full.height()), (640, 360));
        let untouched = decode_mjpeg(&bytes, 0).unwrap();
        assert_eq!((untouched.width(), untouched.height()), (640, 360));
    }

    #[test]
    #[ignore = "release wall-time measurement for the instant bubble"]
    fn bubble_scaled_idct_is_faster_than_full_decode_and_scale() {
        ffmpeg::init().unwrap();
        let bytes = encode_mjpeg(1920, 1080);
        let bubble = 324u32;
        let lowres = idct_lowres(1920, 1080, bubble, bubble);
        assert_eq!(lowres, 1);
        let mut full_decoder = None;
        let mut scaled_decoder = None;
        let warmup = |lowres: i32, slot: &mut Option<MjpegDecoder>| {
            for _ in 0..4 {
                if slot.as_ref().is_none_or(|decoder| decoder.lowres != lowres) {
                    *slot = Some(MjpegDecoder::new(lowres).unwrap());
                }
                slot.as_mut().unwrap().decode(&bytes).unwrap();
            }
        };
        warmup(0, &mut full_decoder);
        warmup(lowres, &mut scaled_decoder);
        let full_frame = full_decoder.as_mut().unwrap().decode(&bytes).unwrap();
        let scaled_frame = scaled_decoder.as_mut().unwrap().decode(&bytes).unwrap();
        assert_eq!((scaled_frame.width(), scaled_frame.height()), (960, 540));
        let (mean, max) = bgra_delta(
            &scale_bgra(&full_frame, bubble, bubble),
            &scale_bgra(&scaled_frame, bubble, bubble),
        );

        let iterations = 40;
        let time = |slot: &mut Option<MjpegDecoder>, source: &FFVideo| {
            let mut scaler = ffmpeg::software::scaling::Context::get(
                source.format(),
                source.width(),
                source.height(),
                Pixel::BGRA,
                bubble,
                bubble,
                ffmpeg::software::scaling::Flags::BILINEAR,
            )
            .unwrap();
            let mut output = FFVideo::empty();
            let start = std::time::Instant::now();
            for _ in 0..iterations {
                let frame = slot.as_mut().unwrap().decode(&bytes).unwrap();
                scaler.run(&frame, &mut output).unwrap();
            }
            start.elapsed().as_secs_f64() * 1e3 / iterations as f64
        };
        let full_ms = time(&mut full_decoder, &full_frame);
        let scaled_ms = time(&mut scaled_decoder, &scaled_frame);
        let speedup = full_ms / scaled_ms;
        println!(
            "mjpeg-idct bubble 1920x1080 -> {bubble}: full+scale {full_ms:.3}ms scaled+scale {scaled_ms:.3}ms speedup {speedup:.2}x bgra_mean {mean:.3} max {max} jpeg_bytes {}",
            bytes.len()
        );
        assert!(
            speedup >= 1.20,
            "expected a bubble-size win, got {speedup:.2}x ({full_ms:.3}ms -> {scaled_ms:.3}ms)"
        );
        assert!(
            max <= 8,
            "bubble pixel delta too large: mean {mean:.3} max {max}"
        );
    }
}
