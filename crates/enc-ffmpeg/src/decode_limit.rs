//! A process-wide cap on the frame size FFmpeg decodes, for processes that
//! decode files they did not record (the render farm). Unset, FFmpeg's own
//! limit applies, as it always has for the desktop app's local files.

use std::{
    ffi::CString,
    os::raw::c_int,
    path::Path,
    ptr,
    sync::atomic::{AtomicI64, Ordering},
};

static MAX_PIXELS: AtomicI64 = AtomicI64::new(0);

/// Holds every decoder opened through this crate and `cap-video-decode`
/// afterwards, including the ones FFmpeg opens while probing a stream, to
/// frames of at most `max_pixels`.
pub fn limit_decode_pixels(max_pixels: i64) {
    MAX_PIXELS.store(max_pixels.max(0), Ordering::Relaxed);
}

pub fn decode_pixel_limit() -> Option<i64> {
    Some(MAX_PIXELS.load(Ordering::Relaxed)).filter(|limit| *limit > 0)
}

/// Applies the limit to a decoder before `avcodec_open2`.
pub fn apply_decode_pixel_limit(context: &mut ffmpeg::codec::context::Context) {
    if let Some(limit) = decode_pixel_limit() {
        unsafe { (*context.as_mut_ptr()).max_pixels = limit };
    }
}

/// Probing decodes a few frames at the stream's real size, which can be far
/// larger than the size the container declares, before any decoder of ours
/// exists to hold the limit.
///
/// # Safety
/// `context` must point to a valid, opened input format context.
pub unsafe fn find_stream_info(context: *mut ffmpeg::ffi::AVFormatContext) -> c_int {
    if context.is_null() {
        return ffmpeg::Error::InvalidData.into();
    }
    let Some(limit) = decode_pixel_limit() else {
        return unsafe { ffmpeg::ffi::avformat_find_stream_info(context, ptr::null_mut()) };
    };
    let streams = unsafe { (*context).nb_streams } as usize;
    let mut options = (0..streams)
        .map(|_| {
            let mut options = ffmpeg::Dictionary::new();
            options.set("max_pixels", &limit.to_string());
            unsafe { options.disown() }
        })
        .collect::<Vec<_>>();
    let found = unsafe { ffmpeg::ffi::avformat_find_stream_info(context, options.as_mut_ptr()) };
    for options in options {
        unsafe { ffmpeg::Dictionary::own(options) };
    }
    found
}

pub fn open_input(path: &Path) -> Result<ffmpeg::format::context::Input, ffmpeg::Error> {
    if decode_pixel_limit().is_none() {
        return ffmpeg::format::input(path);
    }
    let path = path
        .to_str()
        .and_then(|path| CString::new(path).ok())
        .ok_or(ffmpeg::Error::InvalidData)?;
    let mut context = ptr::null_mut();
    unsafe {
        let opened = ffmpeg::ffi::avformat_open_input(
            &mut context,
            path.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
        );
        if opened < 0 {
            return Err(ffmpeg::Error::from(opened));
        }
        let found = find_stream_info(context);
        if found < 0 {
            ffmpeg::ffi::avformat_close_input(&mut context);
            return Err(ffmpeg::Error::from(found));
        }
        Ok(ffmpeg::format::context::Input::wrap(context))
    }
}
