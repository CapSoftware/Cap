use cap_camera::CapturedFrame;
use cap_camera_avfoundation::ImageBufExt;
use cidre::*;
use ffmpeg::{ffi, format::Pixel, software::scaling};
use std::{
    cell::RefCell,
    ffi::c_void,
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{CONVERSION_STATS, CapturedFrameExt};

type CVPixelBufferRef = *mut c_void;

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferGetBaseAddress(pixel_buffer: CVPixelBufferRef) -> *mut u8;
    fn CVPixelBufferGetBytesPerRow(pixel_buffer: CVPixelBufferRef) -> usize;
    fn CVPixelBufferGetWidth(pixel_buffer: CVPixelBufferRef) -> usize;
    fn CVPixelBufferGetHeight(pixel_buffer: CVPixelBufferRef) -> usize;
}

type CachedScaler = (Pixel, u32, u32, scaling::Context, ffmpeg::frame::Video);

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
    #[error("Swscale fallback failed for format '{format}': {reason}")]
    SwscaleFallbackFailed { format: String, reason: String },
    #[error("{0}")]
    Native(#[from] cidre::os::Error),
    #[error("No image buffer available")]
    NoImageBuffer,
}

struct FourccInfo {
    pixel: Pixel,
    bytes_per_pixel: usize,
}

fn fourcc_to_pixel_format(fourcc: &str) -> Option<FourccInfo> {
    match fourcc {
        "ABGR" => Some(FourccInfo {
            pixel: Pixel::ABGR,
            bytes_per_pixel: 4,
        }),
        "b64a" => Some(FourccInfo {
            pixel: Pixel::RGBA64BE,
            bytes_per_pixel: 8,
        }),
        "b48r" => Some(FourccInfo {
            pixel: Pixel::RGB48BE,
            bytes_per_pixel: 6,
        }),
        "L016" => Some(FourccInfo {
            pixel: Pixel::GRAY16LE,
            bytes_per_pixel: 2,
        }),
        _ => None,
    }
}

static FALLBACK_WARNING_LOGGED: AtomicBool = AtomicBool::new(false);

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferLockBaseAddress(pixel_buffer: CVPixelBufferRef, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pixel_buffer: CVPixelBufferRef, flags: u64) -> i32;
}

const CV_PIXEL_BUFFER_LOCK_READ_ONLY: u64 = 1;

#[derive(Clone, Copy)]
struct SamplePlane {
    ptr: *mut u8,
    len: usize,
    stride: usize,
}

struct WrappedSampleBuf {
    _image_buf: cidre::arc::R<cidre::cv::ImageBuf>,
    pixel_buffer: CVPixelBufferRef,
    locked: bool,
}

unsafe impl Send for WrappedSampleBuf {}
unsafe impl Sync for WrappedSampleBuf {}

impl Drop for WrappedSampleBuf {
    fn drop(&mut self) {
        if self.locked {
            unsafe {
                CVPixelBufferUnlockBaseAddress(self.pixel_buffer, CV_PIXEL_BUFFER_LOCK_READ_ONLY);
            }
        }
    }
}

unsafe extern "C" fn release_wrapped_sample_buf(opaque: *mut c_void, _data: *mut u8) {
    if !opaque.is_null() {
        drop(unsafe { Box::from_raw(opaque as *mut Arc<WrappedSampleBuf>) });
    }
}

fn sample_buf_planes(
    image_buf: &cidre::cv::ImageBuf,
    format: &str,
) -> Option<(Pixel, Vec<SamplePlane>, Option<ffmpeg::color::Range>)> {
    let (pixel, plane_count, range) = match format {
        "2vuy" => (Pixel::UYVY422, 0, None),
        "yuvs" => (Pixel::YUYV422, 0, None),
        "BGRA" => (Pixel::BGRA, 0, None),
        "ARGB" => (Pixel::ARGB, 0, None),
        "24BG" => (Pixel::BGR24, 0, None),
        "24RG" => (Pixel::RGB24, 0, None),
        "L008" | "GRAY" => (Pixel::GRAY8, 0, None),
        "L016" => (Pixel::GRAY16LE, 0, None),
        "420v" => (Pixel::NV12, 2, Some(ffmpeg::color::Range::MPEG)),
        "420f" => (Pixel::NV12, 2, Some(ffmpeg::color::Range::JPEG)),
        "y420" => (Pixel::YUV420P, 3, None),
        _ => return None,
    };

    if image_buf.plane_count() != plane_count {
        return None;
    }

    let mut planes = Vec::with_capacity(plane_count.max(1));
    if plane_count == 0 {
        let pixel_buffer = image_buf as *const cidre::cv::ImageBuf as CVPixelBufferRef;
        let ptr = unsafe { CVPixelBufferGetBaseAddress(pixel_buffer) };
        let stride = unsafe { CVPixelBufferGetBytesPerRow(pixel_buffer) };
        let height = unsafe { CVPixelBufferGetHeight(pixel_buffer) };
        if ptr.is_null() || stride == 0 || height == 0 {
            return None;
        }
        planes.push(SamplePlane {
            ptr,
            len: stride.checked_mul(height)?,
            stride,
        });
    } else {
        for plane in 0..plane_count {
            let ptr = image_buf.plane_base_address(plane) as *mut u8;
            let stride = image_buf.plane_bytes_per_row(plane);
            let height = image_buf.plane_height(plane);
            if ptr.is_null() || stride == 0 || height == 0 {
                return None;
            }
            planes.push(SamplePlane {
                ptr,
                len: stride.checked_mul(height)?,
                stride,
            });
        }
    }

    Some((pixel, planes, range))
}

fn wrap_sample_buf(sample_buf: &cidre::cm::SampleBuf) -> Option<ffmpeg::frame::Video> {
    let image_buf = sample_buf.image_buf()?.retained();
    let format_desc = sample_buf.format_desc()?;
    let format = cidre::four_cc_to_str(&mut format_desc.media_sub_type().to_be_bytes());
    let pixel_buffer = (&*image_buf) as *const cidre::cv::ImageBuf as CVPixelBufferRef;

    if unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, CV_PIXEL_BUFFER_LOCK_READ_ONLY) } != 0 {
        return None;
    }

    let Some((pixel, planes, range)) = sample_buf_planes(&image_buf, format) else {
        unsafe {
            CVPixelBufferUnlockBaseAddress(pixel_buffer, CV_PIXEL_BUFFER_LOCK_READ_ONLY);
        }
        return None;
    };

    let owner = Arc::new(WrappedSampleBuf {
        _image_buf: image_buf,
        pixel_buffer,
        locked: true,
    });

    let mut frame = ffmpeg::frame::Video::empty();
    let ptr = unsafe { frame.as_mut_ptr() };
    let format: ffi::AVPixelFormat = pixel.into();
    unsafe {
        (*ptr).format = format as i32;
        (*ptr).width = image_buf_width(&owner) as i32;
        (*ptr).height = image_buf_height(&owner) as i32;
    }

    let mut buffers = Vec::with_capacity(planes.len());
    for plane in &planes {
        let opaque = Box::into_raw(Box::new(Arc::clone(&owner))) as *mut c_void;
        let buffer = unsafe {
            ffi::av_buffer_create(
                plane.ptr,
                plane.len,
                Some(release_wrapped_sample_buf),
                opaque,
                ffi::AV_BUFFER_FLAG_READONLY,
            )
        };
        if buffer.is_null() {
            unsafe {
                drop(Box::from_raw(opaque as *mut Arc<WrappedSampleBuf>));
                for mut buffer in buffers {
                    ffi::av_buffer_unref(&mut buffer);
                }
            }
            return None;
        }
        buffers.push(buffer);
    }

    for (index, (buffer, plane)) in buffers.into_iter().zip(&planes).enumerate() {
        unsafe {
            (*ptr).buf[index] = buffer;
            (*ptr).data[index] = plane.ptr;
            (*ptr).linesize[index] = plane.stride as i32;
        }
    }

    if let Some(range) = range {
        frame.set_color_range(range);
    }

    Some(frame)
}

fn image_buf_width(owner: &WrappedSampleBuf) -> usize {
    unsafe { CVPixelBufferGetWidth(owner.pixel_buffer) }
}

fn image_buf_height(owner: &WrappedSampleBuf) -> usize {
    unsafe { CVPixelBufferGetHeight(owner.pixel_buffer) }
}

impl CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        sample_buf_as_ffmpeg(self.native().sample_buf())
    }
}

// Standalone so consumers holding a bare retained CMSampleBuffer (e.g. the
// native camera preview's CPU fallback) can reuse the same conversion.
pub fn sample_buf_as_ffmpeg(
    sample_buf: &cm::SampleBuf,
) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
    if let Some(frame) = wrap_sample_buf(sample_buf) {
        CONVERSION_STATS.record_zero_copy();
        return Ok(frame);
    }

    let started = std::time::Instant::now();
    let frame = {
        let mut image_buf = sample_buf
            .image_buf()
            .map(|b| b.retained())
            .ok_or(AsFFmpegError::NoImageBuffer)?;

        let width = image_buf.width();
        let height = image_buf.height();
        let plane0_stride = image_buf.plane_bytes_per_row(0);
        let plane1_stride = image_buf.plane_bytes_per_row(1);
        let plane_count = image_buf.plane_count();
        let plane_info: [(usize, usize, usize); 3] = [
            (
                image_buf.plane_bytes_per_row(0),
                image_buf.plane_height(0),
                image_buf.plane_width(0),
            ),
            (
                image_buf.plane_bytes_per_row(1),
                image_buf.plane_height(1),
                image_buf.plane_width(1),
            ),
            (
                image_buf.plane_bytes_per_row(2),
                image_buf.plane_height(2),
                image_buf.plane_width(2),
            ),
        ];

        let format_desc = sample_buf
            .format_desc()
            .ok_or(AsFFmpegError::NoImageBuffer)?;

        let bytes_lock = ImageBufExt::base_addr_lock(
            image_buf.as_mut(),
            cv::pixel_buffer::LockFlags::READ_ONLY,
        )?;

        let res = match cidre::four_cc_to_str(&mut format_desc.media_sub_type().to_be_bytes()) {
            "2vuy" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::UYVY422,
                    width as u32,
                    height as u32,
                );

                let src_stride = plane0_stride;
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
            format @ ("420v" | "420f") => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::NV12,
                    width as u32,
                    height as u32,
                );
                ff_frame.set_color_range(if format == "420f" {
                    ffmpeg::color::Range::JPEG
                } else {
                    ffmpeg::color::Range::MPEG
                });

                let src_stride = plane0_stride;
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                let src_stride = plane1_stride;
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

                let src_stride = plane0_stride;
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

                let src_stride = plane0_stride;
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

                let src_stride = plane0_stride;
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
            "RGBA" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::RGBA,
                    width as u32,
                    height as u32,
                );

                let src_stride = plane0_stride;
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

                let src_stride = plane0_stride;
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
            "24RG" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::RGB24,
                    width as u32,
                    height as u32,
                );

                let src_stride = plane0_stride;
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

                for (plane, &(src_stride, plane_height, row_width)) in plane_info.iter().enumerate()
                {
                    let dest_stride = ff_frame.stride(plane);

                    let src_bytes = bytes_lock.plane_data(plane);
                    let dest_bytes = &mut ff_frame.data_mut(plane);

                    for y in 0..plane_height {
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];
                        dest_row.copy_from_slice(src_row);
                    }
                }

                ff_frame
            }
            "L008" | "GRAY" => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::GRAY8,
                    width as u32,
                    height as u32,
                );

                let src_stride = plane0_stride;
                let dest_stride = ff_frame.stride(0);

                let src_bytes = bytes_lock.plane_data(0);
                let dest_bytes = &mut ff_frame.data_mut(0);

                for y in 0..height {
                    let row_width = width;
                    let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                    let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                    dest_row.copy_from_slice(src_row);
                }

                ff_frame
            }
            format => {
                if let Some(info) = fourcc_to_pixel_format(format) {
                    if !FALLBACK_WARNING_LOGGED.swap(true, Ordering::Relaxed) {
                        tracing::warn!(
                            "Using swscale fallback for camera format '{}' - this may impact performance",
                            format
                        );
                    }

                    let mut src_frame =
                        ffmpeg::frame::Video::new(info.pixel, width as u32, height as u32);

                    let src_stride = plane0_stride;
                    let dest_stride = src_frame.stride(0);
                    let src_bytes = bytes_lock.plane_data(0);
                    let dest_bytes = &mut src_frame.data_mut(0);

                    let row_width = width * info.bytes_per_pixel;
                    for y in 0..height {
                        let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                        let dest_row =
                            &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];
                        dest_row.copy_from_slice(src_row);
                    }

                    thread_local! {
                        static FALLBACK_SCALER: RefCell<Option<CachedScaler>> = const { RefCell::new(None) };
                    }

                    FALLBACK_SCALER.with(|cell| {
                        let mut cached = cell.borrow_mut();

                        let w = width as u32;
                        let h = height as u32;

                        let needs_reinit = cached.as_ref().is_none_or(|(p, cw, ch, _, _)| {
                            *p != info.pixel || *cw != w || *ch != h
                        });

                        if needs_reinit {
                            let scaler = scaling::Context::get(
                                info.pixel,
                                w,
                                h,
                                Pixel::RGBA,
                                w,
                                h,
                                scaling::flag::Flags::FAST_BILINEAR,
                            )
                            .map_err(|e| {
                                AsFFmpegError::SwscaleFallbackFailed {
                                    format: format.to_string(),
                                    reason: format!("Failed to create scaler: {e}"),
                                }
                            })?;

                            let out = ffmpeg::frame::Video::new(Pixel::RGBA, w, h);
                            *cached = Some((info.pixel, w, h, scaler, out));
                        }

                        let (_, _, _, scaler, output) = cached.as_mut().unwrap();

                        scaler.run(&src_frame, output).map_err(|e| {
                            AsFFmpegError::SwscaleFallbackFailed {
                                format: format.to_string(),
                                reason: format!("Conversion failed: {e}"),
                            }
                        })?;

                        let mut cloned = ffmpeg::frame::Video::new(Pixel::RGBA, w, h);
                        let src_data = output.data(0);
                        let dest_data = cloned.data_mut(0);
                        dest_data[..src_data.len()].copy_from_slice(src_data);
                        Ok::<_, AsFFmpegError>(cloned)
                    })?
                } else {
                    return Err(AsFFmpegError::UnsupportedSubType(format.to_string()));
                }
            }
        };

        res
    };

    CONVERSION_STATS.record_copy(started.elapsed().as_nanos() as u64);
    Ok(frame)
}
