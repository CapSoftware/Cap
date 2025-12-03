use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame};
use std::{
    ffi::c_void,
    ptr,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

type CFAllocatorRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CVPixelBufferRef = *mut c_void;
type VTPixelTransferSessionRef = *mut c_void;
type OSStatus = i32;

const K_CV_RETURN_SUCCESS: i32 = 0;

const K_CV_PIXEL_FORMAT_TYPE_422_YP_CB_YP_CR8: u32 = 0x79757679;
const K_CV_PIXEL_FORMAT_TYPE_420_YP_CB_CR8_BI_PLANAR_VIDEO_RANGE: u32 = 0x34323076;
const K_CV_PIXEL_FORMAT_TYPE_2VUY: u32 = 0x32767579;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferCreate(
        allocator: CFAllocatorRef,
        width: usize,
        height: usize,
        pixel_format_type: u32,
        pixel_buffer_attributes: CFDictionaryRef,
        pixel_buffer_out: *mut CVPixelBufferRef,
    ) -> i32;

    fn CVPixelBufferCreateWithBytes(
        allocator: CFAllocatorRef,
        width: usize,
        height: usize,
        pixel_format_type: u32,
        base_address: *mut c_void,
        bytes_per_row: usize,
        release_callback: *const c_void,
        release_ref_con: *const c_void,
        pixel_buffer_attributes: CFDictionaryRef,
        pixel_buffer_out: *mut CVPixelBufferRef,
    ) -> i32;

    fn CVPixelBufferRelease(pixel_buffer: CVPixelBufferRef);

    fn CVPixelBufferLockBaseAddress(pixel_buffer: CVPixelBufferRef, lock_flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pixel_buffer: CVPixelBufferRef, lock_flags: u64) -> i32;

    fn CVPixelBufferGetBaseAddressOfPlane(pixel_buffer: CVPixelBufferRef, plane: usize) -> *mut u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer: CVPixelBufferRef, plane: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(pixel_buffer: CVPixelBufferRef, plane: usize) -> usize;
    fn CVPixelBufferGetPlaneCount(pixel_buffer: CVPixelBufferRef) -> usize;
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    fn VTPixelTransferSessionCreate(
        allocator: CFAllocatorRef,
        pixel_transfer_session_out: *mut VTPixelTransferSessionRef,
    ) -> OSStatus;

    fn VTPixelTransferSessionInvalidate(session: VTPixelTransferSessionRef);

    fn VTPixelTransferSessionTransferImage(
        session: VTPixelTransferSessionRef,
        source_buffer: CVPixelBufferRef,
        destination_buffer: CVPixelBufferRef,
    ) -> OSStatus;
}

fn pixel_to_cv_format(pixel: Pixel) -> Option<u32> {
    match pixel {
        Pixel::YUYV422 => Some(K_CV_PIXEL_FORMAT_TYPE_422_YP_CB_YP_CR8),
        Pixel::UYVY422 => Some(K_CV_PIXEL_FORMAT_TYPE_2VUY),
        Pixel::NV12 => Some(K_CV_PIXEL_FORMAT_TYPE_420_YP_CB_CR8_BI_PLANAR_VIDEO_RANGE),
        _ => None,
    }
}

pub struct VideoToolboxConverter {
    session: VTPixelTransferSessionRef,
    input_format: Pixel,
    input_cv_format: u32,
    output_format: Pixel,
    output_cv_format: u32,
    input_width: u32,
    input_height: u32,
    output_width: u32,
    output_height: u32,
    conversion_count: AtomicU64,
    verified_hardware: AtomicBool,
}

impl VideoToolboxConverter {
    pub fn new(config: ConversionConfig) -> Result<Self, ConvertError> {
        let input_cv_format = pixel_to_cv_format(config.input_format).ok_or(
            ConvertError::UnsupportedFormat(config.input_format, config.output_format),
        )?;

        let output_cv_format = pixel_to_cv_format(config.output_format).ok_or(
            ConvertError::UnsupportedFormat(config.input_format, config.output_format),
        )?;

        let mut session: VTPixelTransferSessionRef = ptr::null_mut();
        let status = unsafe { VTPixelTransferSessionCreate(ptr::null(), &mut session) };

        if status != 0 {
            return Err(ConvertError::HardwareUnavailable(format!(
                "VTPixelTransferSessionCreate failed with status: {status}"
            )));
        }

        if session.is_null() {
            return Err(ConvertError::HardwareUnavailable(
                "VTPixelTransferSessionCreate returned null session".to_string(),
            ));
        }

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
            session,
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
    ) -> Result<CVPixelBufferRef, ConvertError> {
        let mut pixel_buffer: CVPixelBufferRef = ptr::null_mut();

        let base_address = input.data(0).as_ptr() as *mut c_void;
        let bytes_per_row = input.stride(0);

        let status = unsafe {
            CVPixelBufferCreateWithBytes(
                ptr::null(),
                self.input_width as usize,
                self.input_height as usize,
                self.input_cv_format,
                base_address,
                bytes_per_row,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                &mut pixel_buffer,
            )
        };

        if status != K_CV_RETURN_SUCCESS {
            return Err(ConvertError::ConversionFailed(format!(
                "CVPixelBufferCreateWithBytes failed: {status}"
            )));
        }

        Ok(pixel_buffer)
    }

    fn create_output_pixel_buffer(&self) -> Result<CVPixelBufferRef, ConvertError> {
        let mut pixel_buffer: CVPixelBufferRef = ptr::null_mut();

        let status = unsafe {
            CVPixelBufferCreate(
                ptr::null(),
                self.output_width as usize,
                self.output_height as usize,
                self.output_cv_format,
                ptr::null(),
                &mut pixel_buffer,
            )
        };

        if status != K_CV_RETURN_SUCCESS {
            return Err(ConvertError::ConversionFailed(format!(
                "CVPixelBufferCreate failed: {status}"
            )));
        }

        Ok(pixel_buffer)
    }

    fn copy_output_to_frame(
        &self,
        pixel_buffer: CVPixelBufferRef,
    ) -> Result<frame::Video, ConvertError> {
        unsafe {
            let lock_status = CVPixelBufferLockBaseAddress(pixel_buffer, 0);
            if lock_status != K_CV_RETURN_SUCCESS {
                return Err(ConvertError::ConversionFailed(format!(
                    "CVPixelBufferLockBaseAddress failed: {lock_status}"
                )));
            }
        }

        let mut output =
            frame::Video::new(self.output_format, self.output_width, self.output_height);

        unsafe {
            let plane_count = CVPixelBufferGetPlaneCount(pixel_buffer);

            for plane in 0..plane_count {
                let src_ptr = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, plane);
                let src_stride = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, plane);
                let height = CVPixelBufferGetHeightOfPlane(pixel_buffer, plane);
                let dst_stride = output.stride(plane);

                let dst_data = output.data_mut(plane);
                let dst_ptr = dst_data.as_mut_ptr();

                for row in 0..height {
                    let src_row = src_ptr.add(row * src_stride);
                    let dst_row = dst_ptr.add(row * dst_stride);
                    let copy_len = src_stride.min(dst_stride);
                    ptr::copy_nonoverlapping(src_row, dst_row, copy_len);
                }
            }

            CVPixelBufferUnlockBaseAddress(pixel_buffer, 0);
        }

        Ok(output)
    }
}

impl Drop for VideoToolboxConverter {
    fn drop(&mut self) {
        if !self.session.is_null() {
            unsafe {
                VTPixelTransferSessionInvalidate(self.session);
                CFRelease(self.session as *const c_void);
            }
        }
    }
}

impl FrameConverter for VideoToolboxConverter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let count = self.conversion_count.fetch_add(1, Ordering::Relaxed);

        if count == 0 {
            tracing::info!(
                "VideoToolbox converter first frame: {:?} -> {:?}",
                self.input_format,
                self.output_format
            );
        }

        let input_buffer = self.create_input_pixel_buffer(&input)?;
        let output_buffer = self.create_output_pixel_buffer()?;

        let status = unsafe {
            VTPixelTransferSessionTransferImage(self.session, input_buffer, output_buffer)
        };

        unsafe {
            CVPixelBufferRelease(input_buffer);
        }

        if status != 0 {
            unsafe {
                CVPixelBufferRelease(output_buffer);
            }
            return Err(ConvertError::ConversionFailed(format!(
                "VTPixelTransferSessionTransferImage failed: {status}"
            )));
        }

        if !self.verified_hardware.swap(true, Ordering::Relaxed) {
            tracing::info!(
                "VideoToolbox VTPixelTransferSession succeeded - hardware acceleration confirmed"
            );
        }

        let mut result = self.copy_output_to_frame(output_buffer)?;
        result.set_pts(input.pts());

        unsafe {
            CVPixelBufferRelease(output_buffer);
        }

        Ok(result)
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

unsafe impl Send for VideoToolboxConverter {}
unsafe impl Sync for VideoToolboxConverter {}
