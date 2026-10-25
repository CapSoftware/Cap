use std::{cell::RefCell, collections::VecDeque, ffi::c_void, ptr, sync::Arc};

use cap_camera::CapturedFrame;
use cap_camera_windows::PixelFormat;
use ffmpeg::{Packet, ffi, format::Pixel, frame::Video as FFVideo};
use windows::{
    Win32::Media::MediaFoundation::{
        IMF2DBuffer, IMF2DBuffer2, IMFMediaBuffer, MF2DBuffer_LockFlags_Read,
    },
    core::Interface,
};

use crate::{CONVERSION_STATS, CapturedFrameExt};

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

fn src_y(y: usize, height: usize, is_bottom_up: bool) -> usize {
    if is_bottom_up { height - y - 1 } else { y }
}

#[derive(Clone, Copy)]
struct MfPlane {
    ptr: *mut u8,
    len: usize,
    stride: usize,
}

enum MfLock {
    TwoD2(IMF2DBuffer2),
    TwoD(IMF2DBuffer),
    Contiguous,
}

struct WrappedMfBuffer {
    _buffer: IMFMediaBuffer,
    lock: MfLock,
}

unsafe impl Send for WrappedMfBuffer {}
unsafe impl Sync for WrappedMfBuffer {}

impl Drop for WrappedMfBuffer {
    fn drop(&mut self) {
        unsafe {
            match &self.lock {
                MfLock::TwoD2(buffer) => {
                    let _ = buffer.Unlock2D();
                }
                MfLock::TwoD(buffer) => {
                    let _ = buffer.Unlock2D();
                }
                MfLock::Contiguous => {
                    let _ = self._buffer.Unlock();
                }
            }
        }
    }
}

unsafe extern "C" fn release_wrapped_mf_buffer(opaque: *mut c_void, _data: *mut u8) {
    if !opaque.is_null() {
        drop(unsafe { Box::from_raw(opaque as *mut Arc<WrappedMfBuffer>) });
    }
}

fn mf_pixel_format(format: PixelFormat) -> Option<Pixel> {
    Some(match format {
        PixelFormat::NV12 => Pixel::NV12,
        PixelFormat::NV21 => Pixel::NV21,
        PixelFormat::YUYV422 => Pixel::YUYV422,
        PixelFormat::UYVY422 => Pixel::UYVY422,
        PixelFormat::YUV420P | PixelFormat::YV12 | PixelFormat::MJPEG | PixelFormat::H264 => {
            return None;
        }
        PixelFormat::ARGB | PixelFormat::RGB32 => Pixel::BGRA,
        PixelFormat::RGB24 | PixelFormat::BGR24 => Pixel::BGR24,
        PixelFormat::GRAY8 => Pixel::GRAY8,
        PixelFormat::GRAY16 => Pixel::GRAY16LE,
        PixelFormat::RGB565 => Pixel::RGB565LE,
        PixelFormat::P010 => Pixel::P010LE,
    })
}

fn mf_row_bytes(format: PixelFormat, width: usize) -> Option<usize> {
    Some(match format {
        PixelFormat::NV12 | PixelFormat::NV21 | PixelFormat::YUV420P | PixelFormat::GRAY8 => width,
        PixelFormat::YUYV422
        | PixelFormat::UYVY422
        | PixelFormat::GRAY16
        | PixelFormat::RGB565
        | PixelFormat::P010 => width.checked_mul(2)?,
        PixelFormat::RGB24 | PixelFormat::BGR24 => width.checked_mul(3)?,
        PixelFormat::ARGB | PixelFormat::RGB32 => width.checked_mul(4)?,
        PixelFormat::YV12 | PixelFormat::MJPEG | PixelFormat::H264 => return None,
    })
}

fn mf_planes(
    format: PixelFormat,
    width: usize,
    height: usize,
    data: *mut u8,
    len: usize,
    stride: usize,
) -> Option<Vec<MfPlane>> {
    let row_bytes = mf_row_bytes(format, width)?;
    if stride < row_bytes || height == 0 {
        return None;
    }

    let plane = |ptr: *mut u8, len: usize| MfPlane { ptr, len, stride };
    let y_len = stride.checked_mul(height)?;

    match format {
        PixelFormat::NV12 | PixelFormat::NV21 => {
            let uv_len = stride.checked_mul(height / 2)?;
            if len < y_len.checked_add(uv_len)? {
                return None;
            }
            Some(vec![
                plane(data, y_len),
                plane(unsafe { data.add(y_len) }, uv_len),
            ])
        }
        PixelFormat::P010 => {
            let uv_len = stride.checked_mul(height / 2)?;
            if len < y_len.checked_add(uv_len)? {
                return None;
            }
            Some(vec![
                plane(data, y_len),
                plane(unsafe { data.add(y_len) }, uv_len),
            ])
        }
        PixelFormat::YUYV422
        | PixelFormat::UYVY422
        | PixelFormat::ARGB
        | PixelFormat::RGB32
        | PixelFormat::RGB24
        | PixelFormat::BGR24
        | PixelFormat::GRAY8
        | PixelFormat::GRAY16
        | PixelFormat::RGB565 => {
            if len < y_len {
                return None;
            }
            Some(vec![plane(data, y_len)])
        }
        PixelFormat::YUV420P | PixelFormat::YV12 | PixelFormat::MJPEG | PixelFormat::H264 => None,
    }
}

fn lock_mf_buffer(
    buffer: &IMFMediaBuffer,
    format: PixelFormat,
    width: usize,
    height: usize,
) -> Option<(WrappedMfBuffer, Vec<MfPlane>)> {
    unsafe {
        if let Ok(buffer_2d) = buffer.cast::<IMF2DBuffer2>() {
            let mut scanline = ptr::null_mut();
            let mut pitch = 0i32;
            let mut start = ptr::null_mut();
            let mut len = 0u32;
            if buffer_2d
                .Lock2DSize(
                    MF2DBuffer_LockFlags_Read,
                    &mut scanline,
                    &mut pitch,
                    &mut start,
                    &mut len,
                )
                .is_ok()
            {
                if !start.is_null()
                    && pitch > 0
                    && len > 0
                    && let Some(planes) =
                        mf_planes(format, width, height, start, len as usize, pitch as usize)
                {
                    return Some((
                        WrappedMfBuffer {
                            _buffer: buffer.clone(),
                            lock: MfLock::TwoD2(buffer_2d),
                        },
                        planes,
                    ));
                }

                let _ = buffer_2d.Unlock2D();
            }
        }

        if let Ok(buffer_2d) = buffer.cast::<IMF2DBuffer>() {
            let mut scanline = ptr::null_mut();
            let mut pitch = 0i32;
            if buffer_2d.Lock2D(&mut scanline, &mut pitch).is_ok() {
                if !scanline.is_null()
                    && pitch > 0
                    && let Ok(len) = buffer_2d.GetContiguousLength()
                    && let Some(planes) = mf_planes(
                        format,
                        width,
                        height,
                        scanline,
                        len as usize,
                        pitch as usize,
                    )
                {
                    return Some((
                        WrappedMfBuffer {
                            _buffer: buffer.clone(),
                            lock: MfLock::TwoD(buffer_2d),
                        },
                        planes,
                    ));
                }

                let _ = buffer_2d.Unlock2D();
            }
        }

        let mut data = ptr::null_mut();
        let mut len = 0u32;
        if buffer.Lock(&mut data, None, Some(&mut len)).is_ok() {
            if !data.is_null()
                && len > 0
                && let Some(row_bytes) = mf_row_bytes(format, width)
                && let Some(planes) =
                    mf_planes(format, width, height, data, len as usize, row_bytes)
            {
                return Some((
                    WrappedMfBuffer {
                        _buffer: buffer.clone(),
                        lock: MfLock::Contiguous,
                    },
                    planes,
                ));
            }

            let _ = buffer.Unlock();
        }
    }

    None
}

pub fn media_buffer_as_ffmpeg(
    buffer: &IMFMediaBuffer,
    format: PixelFormat,
    width: usize,
    height: usize,
    is_bottom_up: bool,
) -> Option<FFVideo> {
    if !should_use_2d_lock(format, is_bottom_up) || width == 0 || height == 0 {
        return None;
    }

    let pixel = mf_pixel_format(format)?;
    let (owner, planes) = lock_mf_buffer(buffer, format, width, height)?;
    wrap_mf_frame(&planes, pixel, width as u32, height as u32, Arc::new(owner))
}

// UYVY and NV21 use the format-converting copy paths, which lock with
// IMFMediaBuffer::Lock; all consumers of a buffer must use the same lock type.
pub fn should_use_2d_lock(format: PixelFormat, is_bottom_up: bool) -> bool {
    !is_bottom_up
        && format != PixelFormat::UYVY422
        && format != PixelFormat::NV21
        && mf_pixel_format(format).is_some()
}

pub fn with_media_buffer_data<R>(
    buffer: &IMFMediaBuffer,
    format: PixelFormat,
    width: usize,
    height: usize,
    f: impl FnOnce(&[u8], usize, usize) -> R,
) -> Option<R> {
    if !should_use_2d_lock(format, false) {
        return None;
    }

    let (owner, planes) = lock_mf_buffer(buffer, format, width, height)?;
    let total_len = planes.iter().map(|plane| plane.len).sum::<usize>();
    let data = unsafe { std::slice::from_raw_parts(planes[0].ptr, total_len) };
    let primary_stride = planes[0].stride;
    let secondary_stride = planes.get(1).map_or(primary_stride, |plane| plane.stride);
    let result = f(data, primary_stride, secondary_stride);
    drop(owner);
    Some(result)
}

pub fn copy_media_buffer_to_ffmpeg(
    buffer: &IMFMediaBuffer,
    format: PixelFormat,
    width: usize,
    height: usize,
) -> Option<FFVideo> {
    if !should_use_2d_lock(format, false) {
        return None;
    }

    let pixel = mf_pixel_format(format)?;
    let row_bytes = mf_row_bytes(format, width)?;
    let (owner, planes) = lock_mf_buffer(buffer, format, width, height)?;
    let mut frame = FFVideo::new(pixel, width as u32, height as u32);

    for (index, plane) in planes.iter().enumerate() {
        let plane_height = plane.len / plane.stride;
        let destination_stride = frame.stride(index);
        let destination = frame.data_mut(index);

        for row in 0..plane_height {
            let source =
                unsafe { std::slice::from_raw_parts(plane.ptr.add(row * plane.stride), row_bytes) };
            let destination_start = row * destination_stride;
            destination[destination_start..destination_start + row_bytes].copy_from_slice(source);
        }
    }

    drop(owner);
    Some(frame)
}

fn wrap_mf_frame(
    planes: &[MfPlane],
    pixel: Pixel,
    width: u32,
    height: u32,
    owner: Arc<WrappedMfBuffer>,
) -> Option<FFVideo> {
    let mut frame = FFVideo::empty();
    let ptr = unsafe { frame.as_mut_ptr() };
    let format: ffi::AVPixelFormat = pixel.into();
    unsafe {
        (*ptr).format = format as i32;
        (*ptr).width = width as i32;
        (*ptr).height = height as i32;
    }

    let mut buffers = Vec::with_capacity(planes.len());
    for plane in planes {
        let opaque = Box::into_raw(Box::new(Arc::clone(&owner))) as *mut c_void;
        let buffer = unsafe {
            ffi::av_buffer_create(
                plane.ptr,
                plane.len,
                Some(release_wrapped_mf_buffer),
                opaque,
                ffi::AV_BUFFER_FLAG_READONLY,
            )
        };

        if buffer.is_null() {
            unsafe {
                drop(Box::from_raw(opaque as *mut Arc<WrappedMfBuffer>));
                for mut buffer in buffers {
                    ffi::av_buffer_unref(&mut buffer);
                }
            }
            return None;
        }

        buffers.push(buffer);
    }

    for (index, (buffer, plane)) in buffers.into_iter().zip(planes).enumerate() {
        unsafe {
            (*ptr).buf[index] = buffer;
            (*ptr).data[index] = plane.ptr;
            (*ptr).linesize[index] = plane.stride as i32;
        }
    }

    Some(frame)
}

impl CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let native = self.native();
        let width = native.width;
        let height = native.height;
        let is_bottom_up = native.is_bottom_up;

        if width == 0 || height == 0 {
            return Err(AsFFmpegError::Empty);
        }

        let started = std::time::Instant::now();

        if should_use_2d_lock(native.pixel_format, is_bottom_up)
            && let Some(buffer) = native.media_buffer()
            && let Some(frame) =
                copy_media_buffer_to_ffmpeg(&buffer, native.pixel_format, width, height)
        {
            CONVERSION_STATS.record_copy(started.elapsed().as_nanos() as u64);
            return Ok(frame);
        }

        let bytes = native.bytes().map_err(AsFFmpegError::FailedToGetBytes)?;

        if bytes.is_empty() {
            return Err(AsFFmpegError::Empty);
        }

        let frame = match native.pixel_format {
            PixelFormat::YUV420P => {
                let mut ff_frame = FFVideo::new(Pixel::YUV420P, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let row_width = width;
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let stride = ff_frame.stride(1);
                let half_height = height / 2;
                for y in 0..half_height {
                    let row_width = width / 2;
                    let src_row =
                        &bytes[width * height + src_y(y, half_height, is_bottom_up) * row_width..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];
                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let stride = ff_frame.stride(2);
                for y in 0..half_height {
                    let row_width = width / 2;
                    let src_row = &bytes[width * height
                        + width * height / 4
                        + src_y(y, half_height, is_bottom_up) * row_width..];
                    let dest_row = &mut ff_frame.data_mut(2)[y * stride..];
                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::NV12 => {
                let mut ff_frame = FFVideo::new(Pixel::NV12, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..width].copy_from_slice(&src_row[0..width]);
                }

                let stride = ff_frame.stride(1);
                let uv_base = &bytes[width * height..];
                let half_height = height / 2;
                for y in 0..half_height {
                    let row_width = width;
                    let src_row = &uv_base[src_y(y, half_height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * src_stride..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let v_offset = width * height;
                let u_offset = v_offset + (width / 2) * (height / 2);
                let stride_u = ff_frame.stride(1);
                let stride_v = ff_frame.stride(2);
                let half_height = height / 2;

                for y in 0..half_height {
                    let row_width = width / 2;
                    let sy = src_y(y, half_height, is_bottom_up);
                    let src_v = &bytes[v_offset + sy * row_width..];
                    let src_u = &bytes[u_offset + sy * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * src_stride..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
            PixelFormat::NV21 => {
                let mut ff_frame = FFVideo::new(Pixel::NV12, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..width].copy_from_slice(&src_row[0..width]);
                }

                let stride = ff_frame.stride(1);
                let src_uv = &bytes[width * height..];
                let half_height = height / 2;

                for y in 0..half_height {
                    let row_width = width;
                    let src_row = &src_uv[src_y(y, half_height, is_bottom_up) * row_width..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * src_stride..];
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
                    let src_row = &bytes[src_y(y, height, is_bottom_up) * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                let stride = ff_frame.stride(1);
                let uv_offset = width * height * 2;
                let src_stride = width * 2;
                let half_height = height / 2;

                for y in 0..half_height {
                    let src_row =
                        &bytes[uv_offset + src_y(y, half_height, is_bottom_up) * src_stride..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];
                    dest_row[0..src_stride].copy_from_slice(&src_row[0..src_stride]);
                }

                ff_frame
            }
            PixelFormat::H264 => decode_h264(&bytes)?,
        };

        CONVERSION_STATS.record_copy(started.elapsed().as_nanos() as u64);
        Ok(frame)
    }
}

#[cfg(test)]
mod conversion_tests {
    use super::*;
    use cap_camera_windows::Frame;
    use cap_mediafoundation_utils::IMFMediaBufferExt;
    use windows::Win32::Media::MediaFoundation::{MFCreate2DMediaBuffer, MFCreateMemoryBuffer};

    #[test]
    fn nv12_2d_buffer_can_be_wrapped_twice() {
        cap_mediafoundation_utils::thread_init();

        let width = 80;
        let height = 48;
        let buffer =
            unsafe { MFCreate2DMediaBuffer(width, height, u32::from_le_bytes(*b"NV12"), false) }
                .expect("2D buffer");

        let first = media_buffer_as_ffmpeg(
            &buffer,
            PixelFormat::NV12,
            width as usize,
            height as usize,
            false,
        )
        .expect("first frame");
        let second = media_buffer_as_ffmpeg(
            &buffer,
            PixelFormat::NV12,
            width as usize,
            height as usize,
            false,
        );

        assert!(second.is_some(), "second lock failed");
        drop(first);
        let third = media_buffer_as_ffmpeg(
            &buffer,
            PixelFormat::NV12,
            width as usize,
            height as usize,
            false,
        );
        assert!(third.is_some(), "third lock failed");
    }

    #[test]
    fn copy_conversion_can_nest_inside_zero_copy_frame() {
        cap_mediafoundation_utils::thread_init();

        let width = 80;
        let height = 48;
        let buffer =
            unsafe { MFCreate2DMediaBuffer(width, height, u32::from_le_bytes(*b"NV12"), false) }
                .expect("2D buffer");

        let zero_copy = media_buffer_as_ffmpeg(
            &buffer,
            PixelFormat::NV12,
            width as usize,
            height as usize,
            false,
        )
        .expect("zero-copy frame");
        let copied = copy_media_buffer_to_ffmpeg(
            &buffer,
            PixelFormat::NV12,
            width as usize,
            height as usize,
        )
        .expect("copied frame");

        assert_eq!(copied.format(), Pixel::NV12);
        assert_eq!(copied.width(), width);
        assert_eq!(copied.height(), height);

        let data_len = with_media_buffer_data(
            &buffer,
            PixelFormat::NV12,
            width as usize,
            height as usize,
            |data, primary_stride, secondary_stride| {
                assert_eq!(primary_stride, secondary_stride);
                assert!(primary_stride >= width as usize);
                data.len()
            },
        )
        .expect("locked data");

        assert!(data_len >= width as usize * height as usize * 3 / 2);
        drop(zero_copy);
    }

    #[test]
    fn nv12_media_buffer_is_wrapped_without_copying() {
        cap_mediafoundation_utils::thread_init();

        let width = 80;
        let height = 48;
        let stride = 80;
        let len = stride * height + stride * (height / 2);
        let buffer = unsafe { MFCreateMemoryBuffer(len as u32) }.expect("buffer");

        {
            let mut lock = buffer.lock_for_write().expect("write lock");
            for row in 0..height {
                for column in 0..width {
                    lock[row * stride + column] = (row + column) as u8;
                }
            }
            let uv = stride * height;
            for row in 0..height / 2 {
                for column in 0..width {
                    lock[uv + row * stride + column] = (row * 3 + column) as u8;
                }
            }
        }
        unsafe { buffer.SetCurrentLength(len as u32) }.expect("length");

        let frame = media_buffer_as_ffmpeg(&buffer, PixelFormat::NV12, width, height, false)
            .expect("zero-copy frame");

        assert_eq!(frame.format(), Pixel::NV12);
        assert_eq!(frame.width(), width as u32);
        assert_eq!(frame.height(), height as u32);
        assert_eq!(frame.stride(0), stride);
        assert_eq!(frame.stride(1), stride);
        assert_eq!(frame.data(0)[0], 0);
        assert_eq!(frame.data(0)[stride + 1], 2);
        assert_eq!(frame.data(1)[0], 0);
        assert_eq!(frame.data(1)[stride + 2], 5);
    }

    #[test]
    fn as_ffmpeg_keeps_nv12_for_nv21_frames() {
        cap_mediafoundation_utils::thread_init();

        let width = 80;
        let height = 48;
        let stride = 80;
        let len = stride * height + stride * (height / 2);
        let buffer = unsafe { MFCreateMemoryBuffer(len as u32) }.expect("buffer");
        unsafe { buffer.SetCurrentLength(len as u32) }.expect("length");

        let frame = Frame::from_media_foundation(
            buffer,
            PixelFormat::NV21,
            width,
            height,
            false,
            std::time::Duration::ZERO,
            0,
        );
        let captured =
            cap_camera::CapturedFrame::from_windows_frame(frame, std::time::Duration::ZERO);
        let converted = captured.as_ffmpeg().expect("conversion");

        assert_eq!(converted.format(), Pixel::NV12);
        assert_eq!(converted.width(), width as u32);
        assert_eq!(converted.height(), height as u32);
    }
}
