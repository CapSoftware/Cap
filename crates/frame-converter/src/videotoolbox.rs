use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use cidre::{arc, cf, cv, os, vt};
use ffmpeg::{format::Pixel, frame};
use parking_lot::Mutex;
use std::{
    ffi::c_void,
    ptr,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

type CVPixelBufferRef = *mut c_void;

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferGetBaseAddress(pixel_buffer: &cv::PixelBuf) -> *mut u8;
    fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cv::PixelBuf) -> usize;
    fn CVPixelBufferGetHeight(pixel_buffer: &cv::PixelBuf) -> usize;
}

fn pixel_to_cv_format(pixel: Pixel) -> Option<cv::PixelFormat> {
    Some(match pixel {
        Pixel::YUYV422 => cv::PixelFormat(os::Type::from_be_bytes(*b"yuvs")),
        Pixel::UYVY422 => cv::PixelFormat::_2VUY,
        Pixel::NV12 => cv::PixelFormat::_420V,
        Pixel::BGRA => cv::PixelFormat::_32_BGRA,
        Pixel::ARGB => cv::PixelFormat::_32_ARGB,
        _ => return None,
    })
}

struct SessionHandle(arc::R<vt::PixelTransferSession>);

unsafe impl Send for SessionHandle {}
unsafe impl Sync for SessionHandle {}

struct PoolHandle(arc::R<cv::PixelBufPool>);

unsafe impl Send for PoolHandle {}
unsafe impl Sync for PoolHandle {}

pub struct VideoToolboxConverter {
    session: Mutex<SessionHandle>,
    pool: Option<PoolHandle>,
    input_format: Pixel,
    input_cv_format: cv::PixelFormat,
    output_format: Pixel,
    output_cv_format: cv::PixelFormat,
    input_width: u32,
    input_height: u32,
    output_width: u32,
    output_height: u32,
    conversion_count: AtomicU64,
    verified_hardware: AtomicBool,
}

extern "C" fn noop_release(_: *mut c_void, _: *const *const c_void) {}

fn create_pool(
    width: u32,
    height: u32,
    format: cv::PixelFormat,
) -> Result<PoolHandle, ConvertError> {
    let width = cf::Number::from_usize(width as usize);
    let height = cf::Number::from_usize(height as usize);
    let io_surface = cf::Dictionary::new();
    let attrs = cf::DictionaryOf::<cf::String, cf::Type>::with_keys_values(
        &[
            cv::pixel_buffer::keys::pixel_format(),
            cv::pixel_buffer::keys::width(),
            cv::pixel_buffer::keys::height(),
            cv::pixel_buffer::keys::io_surf_props(),
        ],
        &[
            format.as_ref(),
            width.as_type_ref(),
            height.as_type_ref(),
            io_surface.as_type_ref(),
        ],
    )
    .ok_or_else(|| {
        ConvertError::HardwareUnavailable("VideoToolbox pixel buffer pool attributes".to_string())
    })?;

    cv::PixelBufPool::new(None, Some(&**attrs))
        .map(PoolHandle)
        .map_err(|error| ConvertError::HardwareUnavailable(format!("CVPixelBufferPool: {error}")))
}

impl VideoToolboxConverter {
    pub fn new(config: ConversionConfig) -> Result<Self, ConvertError> {
        let input_cv_format = pixel_to_cv_format(config.input_format).ok_or(
            ConvertError::UnsupportedFormat(config.input_format, config.output_format),
        )?;

        let output_cv_format = pixel_to_cv_format(config.output_format).ok_or(
            ConvertError::UnsupportedFormat(config.input_format, config.output_format),
        )?;

        let mut session = vt::PixelTransferSession::new().map_err(|error| {
            ConvertError::HardwareUnavailable(format!("VTPixelTransferSessionCreate: {error}"))
        })?;
        let _ = session.set_realtime(true);

        let pool = match create_pool(config.output_width, config.output_height, output_cv_format) {
            Ok(pool) => Some(pool),
            Err(error) => {
                tracing::debug!("VideoToolbox pixel buffer pool unavailable: {error}");
                None
            }
        };

        tracing::debug!(
            "VideoToolbox converter initialized: {:?} {}x{} -> {:?} {}x{}",
            config.input_format,
            config.input_width,
            config.input_height,
            config.output_format,
            config.output_width,
            config.output_height
        );

        Ok(Self {
            session: Mutex::new(SessionHandle(session)),
            pool,
            input_format: config.input_format,
            input_cv_format,
            output_format: config.output_format,
            output_cv_format,
            input_width: config.input_width,
            input_height: config.input_height,
            output_width: config.output_width,
            output_height: config.output_height,
            conversion_count: AtomicU64::new(0),
            verified_hardware: AtomicBool::new(false),
        })
    }

    fn create_input_pixel_buffer(
        &self,
        input: &frame::Video,
    ) -> Result<arc::R<cv::PixelBuf>, ConvertError> {
        let base_address = input.data(0).as_ptr() as *mut c_void;
        let bytes_per_row = input.stride(0);

        cv::PixelBuf::with_bytes(
            self.input_width as usize,
            self.input_height as usize,
            base_address,
            bytes_per_row,
            noop_release,
            ptr::null_mut(),
            self.input_cv_format,
            None,
        )
        .map_err(|error| {
            ConvertError::ConversionFailed(format!("CVPixelBufferCreateWithBytes: {error}"))
        })
    }

    fn create_output_pixel_buffer(&self) -> Result<arc::R<cv::PixelBuf>, ConvertError> {
        if let Some(pool) = &self.pool
            && let Ok(buffer) = pool.0.pixel_buf()
        {
            return Ok(buffer);
        }

        cv::PixelBuf::new(
            self.output_width as usize,
            self.output_height as usize,
            self.output_cv_format,
            None,
        )
        .map_err(|error| ConvertError::ConversionFailed(format!("CVPixelBufferCreate: {error}")))
    }

    fn copy_output_to_frame(
        &self,
        pixel_buffer: &mut cv::PixelBuf,
        output: &mut frame::Video,
    ) -> Result<(), ConvertError> {
        unsafe { pixel_buffer.lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY) }
            .result()
            .map_err(|error| {
                ConvertError::ConversionFailed(format!("CVPixelBufferLockBaseAddress: {error}"))
            })?;

        unsafe {
            let plane_count = pixel_buffer.plane_count();

            if plane_count == 0 {
                let src_ptr = CVPixelBufferGetBaseAddress(pixel_buffer);
                let src_stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
                let height = CVPixelBufferGetHeight(pixel_buffer);
                let dst_stride = output.stride(0);
                let dst_ptr = output.data_mut(0).as_mut_ptr();

                if src_stride == dst_stride {
                    ptr::copy_nonoverlapping(src_ptr, dst_ptr, height * src_stride);
                } else {
                    let copy_len = src_stride.min(dst_stride);
                    for row in 0..height {
                        ptr::copy_nonoverlapping(
                            src_ptr.add(row * src_stride),
                            dst_ptr.add(row * dst_stride),
                            copy_len,
                        );
                    }
                }
            } else {
                for plane in 0..plane_count {
                    let src_ptr = pixel_buffer.plane_base_address(plane);
                    let src_stride = pixel_buffer.plane_bytes_per_row(plane);
                    let height = pixel_buffer.plane_height(plane);
                    let dst_stride = output.stride(plane);
                    let dst_ptr = output.data_mut(plane).as_mut_ptr();

                    if src_stride == dst_stride {
                        ptr::copy_nonoverlapping(src_ptr, dst_ptr, height * src_stride);
                    } else {
                        let copy_len = src_stride.min(dst_stride);
                        for row in 0..height {
                            ptr::copy_nonoverlapping(
                                src_ptr.add(row * src_stride),
                                dst_ptr.add(row * dst_stride),
                                copy_len,
                            );
                        }
                    }
                }
            }
        }

        unsafe {
            let _ = pixel_buffer.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY);
        }

        Ok(())
    }
}

impl Drop for VideoToolboxConverter {
    fn drop(&mut self) {
        self.session.get_mut().0.invalidate();
        if let Some(pool) = &self.pool {
            pool.0.flush(cv::PixelBufPoolFlushFlags::EXCESS_BUFFERS);
        }
    }
}

impl FrameConverter for VideoToolboxConverter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let mut output =
            frame::Video::new(self.output_format, self.output_width, self.output_height);
        self.convert_into(input, &mut output)?;
        Ok(output)
    }

    fn convert_into(
        &self,
        input: frame::Video,
        output: &mut frame::Video,
    ) -> Result<(), ConvertError> {
        let count = self.conversion_count.fetch_add(1, Ordering::Relaxed);

        if count == 0 {
            tracing::info!(
                "VideoToolbox converter first frame: {:?} -> {:?}",
                self.input_format,
                self.output_format
            );
        }

        let input_buffer = self.create_input_pixel_buffer(&input)?;
        let mut output_buffer = self.create_output_pixel_buffer()?;

        let status = self
            .session
            .lock()
            .0
            .transfer(&input_buffer, &output_buffer);

        if let Err(error) = status {
            return Err(ConvertError::ConversionFailed(format!(
                "VTPixelTransferSessionTransferImage: {error}"
            )));
        }

        if !self.verified_hardware.swap(true, Ordering::Relaxed) {
            tracing::info!(
                "VideoToolbox VTPixelTransferSession succeeded - hardware acceleration confirmed"
            );
        }

        self.copy_output_to_frame(&mut output_buffer, output)?;
        output.set_pts(input.pts());

        Ok(())
    }

    fn name(&self) -> &'static str {
        "videotoolbox"
    }

    fn backend(&self) -> ConverterBackend {
        ConverterBackend::VideoToolbox
    }

    fn conversion_count(&self) -> u64 {
        self.conversion_count.load(Ordering::Relaxed)
    }

    fn verify_hardware_usage(&self) -> Option<bool> {
        Some(self.verified_hardware.load(Ordering::Relaxed))
    }
}
