use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame};
use parking_lot::Mutex;
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
const K_CV_PIXEL_FORMAT_TYPE_32_BGRA: u32 = 0x42475241;
const K_CV_PIXEL_FORMAT_TYPE_32_ARGB: u32 = 0x00000020;

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
    fn CVPixelBufferGetBaseAddress(pixel_buffer: CVPixelBufferRef) -> *mut u8;
    fn CVPixelBufferGetBytesPerRow(pixel_buffer: CVPixelBufferRef) -> usize;
    fn CVPixelBufferGetHeight(pixel_buffer: CVPixelBufferRef) -> usize;
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
        Pixel::BGRA => Some(K_CV_PIXEL_FORMAT_TYPE_32_BGRA),
        Pixel::ARGB => Some(K_CV_PIXEL_FORMAT_TYPE_32_ARGB),
        _ => None,
    }
}

struct SessionHandle(VTPixelTransferSessionRef);

unsafe impl Send for SessionHandle {}

struct OwnedPixelBuffer(CVPixelBufferRef);

unsafe impl Send for OwnedPixelBuffer {}

impl OwnedPixelBuffer {
    fn as_ptr(&self) -> CVPixelBufferRef {
        self.0
    }
}

impl Drop for OwnedPixelBuffer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CVPixelBufferRelease(self.0);
            }
        }
    }
}

#[derive(Clone, Copy)]
struct PlaneCopyRegion {
    src_ptr: *const u8,
    src_stride: usize,
    dst_ptr: *mut u8,
    dst_stride: usize,
    height: usize,
}

unsafe fn copy_strided_plane(region: PlaneCopyRegion) {
    if region.src_stride == region.dst_stride {
        unsafe {
            ptr::copy_nonoverlapping(
                region.src_ptr,
                region.dst_ptr,
                region.height * region.src_stride,
            );
        }
        return;
    }

    let copy_len = region.src_stride.min(region.dst_stride);
    for row in 0..region.height {
        unsafe {
            let src_row = region.src_ptr.add(row * region.src_stride);
            let dst_row = region.dst_ptr.add(row * region.dst_stride);
            ptr::copy_nonoverlapping(src_row, dst_row, copy_len);
        }
    }
}

pub struct VideoToolboxConverter {
    session: Mutex<SessionHandle>,
    reusable_output_buffer: Mutex<Option<OwnedPixelBuffer>>,
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
            session: Mutex::new(SessionHandle(session)),
            reusable_output_buffer: Mutex::new(None),
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
    ) -> Result<OwnedPixelBuffer, ConvertError> {
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

        Ok(OwnedPixelBuffer(pixel_buffer))
    }

    fn take_or_create_output_pixel_buffer(&self) -> Result<OwnedPixelBuffer, ConvertError> {
        if let Some(cached) = self.reusable_output_buffer.lock().take() {
            return Ok(cached);
        }

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

        Ok(OwnedPixelBuffer(pixel_buffer))
    }

    fn recycle_output_pixel_buffer(&self, buffer: OwnedPixelBuffer) {
        let mut slot = self.reusable_output_buffer.lock();
        if slot.is_none() {
            *slot = Some(buffer);
        }
    }

    fn copy_output_to_frame(
        &self,
        pixel_buffer: CVPixelBufferRef,
        output: &mut frame::Video,
    ) -> Result<(), ConvertError> {
        let lock_status = unsafe { CVPixelBufferLockBaseAddress(pixel_buffer, 0) };
        if lock_status != K_CV_RETURN_SUCCESS {
            return Err(ConvertError::ConversionFailed(format!(
                "CVPixelBufferLockBaseAddress failed: {lock_status}"
            )));
        }

        unsafe {
            let plane_count = CVPixelBufferGetPlaneCount(pixel_buffer);

            if plane_count == 0 {
                let region = PlaneCopyRegion {
                    src_ptr: CVPixelBufferGetBaseAddress(pixel_buffer),
                    src_stride: CVPixelBufferGetBytesPerRow(pixel_buffer),
                    dst_ptr: output.data_mut(0).as_mut_ptr(),
                    dst_stride: output.stride(0),
                    height: CVPixelBufferGetHeight(pixel_buffer),
                };
                copy_strided_plane(region);
            } else {
                for plane in 0..plane_count {
                    let region = PlaneCopyRegion {
                        src_ptr: CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, plane),
                        src_stride: CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, plane),
                        dst_ptr: output.data_mut(plane).as_mut_ptr(),
                        dst_stride: output.stride(plane),
                        height: CVPixelBufferGetHeightOfPlane(pixel_buffer, plane),
                    };
                    copy_strided_plane(region);
                }
            }

            CVPixelBufferUnlockBaseAddress(pixel_buffer, 0);
        }

        Ok(())
    }
}

impl Drop for VideoToolboxConverter {
    fn drop(&mut self) {
        let session = self.session.get_mut().0;
        if !session.is_null() {
            unsafe {
                VTPixelTransferSessionInvalidate(session);
                CFRelease(session as *const c_void);
            }
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
        let output_buffer = self.take_or_create_output_pixel_buffer()?;

        let status = {
            let session_guard = self.session.lock();
            unsafe {
                VTPixelTransferSessionTransferImage(
                    session_guard.0,
                    input_buffer.as_ptr(),
                    output_buffer.as_ptr(),
                )
            }
        };

        drop(input_buffer);

        if status != 0 {
            return Err(ConvertError::ConversionFailed(format!(
                "VTPixelTransferSessionTransferImage failed: {status}"
            )));
        }

        if !self.verified_hardware.swap(true, Ordering::Relaxed) {
            tracing::info!(
                "VideoToolbox VTPixelTransferSession succeeded - hardware acceleration confirmed"
            );
        }

        self.copy_output_to_frame(output_buffer.as_ptr(), output)?;
        output.set_pts(input.pts());
        self.recycle_output_pixel_buffer(output_buffer);

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
