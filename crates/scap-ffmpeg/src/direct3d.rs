use ffmpeg::format::Pixel;
use scap_direct3d::{MappedFrame, PixelFormat, ReadbackError};
use std::ffi::c_void;
use std::time::Duration;

pub type AsFFmpegError = ReadbackError;

/// Readback deadline. The default polls within it; `CAP_READBACK_BLOCKING` opts into an
/// unbounded `Map` when the copy is known to finish quickly.
const READBACK_BUDGET: Duration = Duration::from_millis(8);

impl super::AsFFmpeg for scap_direct3d::Frame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let mapped = self.map_readback(READBACK_BUDGET)?;
        let format = mapped.pixel_format().as_ffmpeg();
        wrap_mapped_frame(mapped, format)
    }
}

unsafe extern "C" fn release_mapped_frame(opaque: *mut c_void, _data: *mut u8) {
    drop(unsafe { Box::from_raw(opaque.cast::<MappedFrame>()) });
}

/// Wraps the mapped staging texture into an `AVFrame` whose backing `AVBufferRef` owns the mapping.
/// The pixels are never copied: the encoder reads the staging texture directly, and the last frame
/// reference unmaps it and returns it to the pool.
fn wrap_mapped_frame(
    mapped: MappedFrame,
    format: Pixel,
) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
    let data = mapped.data_ptr();
    let size = mapped.data_len();
    let row_pitch = mapped.row_pitch() as i32;
    let width = mapped.width();
    let height = mapped.height();

    let mut frame = ffmpeg::frame::Video::empty();

    unsafe {
        let opaque = Box::into_raw(Box::new(mapped)).cast::<c_void>();
        let buffer = ffmpeg::ffi::av_buffer_create(
            data,
            size,
            Some(release_mapped_frame),
            opaque,
            ffmpeg::ffi::AV_BUFFER_FLAG_READONLY,
        );

        if buffer.is_null() {
            drop(Box::from_raw(opaque.cast::<MappedFrame>()));
            return Err(ReadbackError::FrameBufferAllocation);
        }

        frame.set_format(format);
        frame.set_width(width);
        frame.set_height(height);

        let raw = frame.as_mut_ptr();
        (*raw).buf[0] = buffer;
        (*raw).data[0] = data;
        (*raw).linesize[0] = row_pitch;
    }

    Ok(frame)
}

pub trait PixelFormatExt {
    fn as_ffmpeg(&self) -> Pixel;
}

impl PixelFormatExt for PixelFormat {
    fn as_ffmpeg(&self) -> Pixel {
        match self {
            PixelFormat::R8G8B8A8Unorm => Pixel::RGBA,
            PixelFormat::B8G8R8A8Unorm => Pixel::BGRA,
        }
    }
}
