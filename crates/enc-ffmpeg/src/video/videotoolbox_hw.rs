//! VideoToolbox hardware-frame input for ffmpeg encoders.
//!
//! ScreenCaptureKit and AVFoundation vend IOSurface-backed NV12
//! CVPixelBuffers; feeding them to `h264_videotoolbox` as software `AVFrame`s
//! costs a full-frame lock + memcpy per frame (and VideoToolbox copies the
//! planes again internally). Wrapping the CVPixelBuffer as an
//! `AV_PIX_FMT_VIDEOTOOLBOX` frame lets the encoder read the IOSurface
//! directly — zero CPU pixel work.

use std::ffi::c_void;
use std::ptr::{null, null_mut};

use ffmpeg::sys::{
    AVBufferRef, AVCodecContext, AVHWDeviceType, AVHWFramesContext, AVPixelFormat,
    av_buffer_create, av_buffer_ref, av_buffer_unref, av_hwdevice_ctx_create, av_hwframe_ctx_alloc,
    av_hwframe_ctx_init,
};

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

#[derive(thiserror::Error, Debug)]
pub enum VideoToolboxHwError {
    #[error("Failed to create VideoToolbox hardware device context")]
    DeviceCreation,
    #[error("Failed to allocate VideoToolbox hardware frames context")]
    FramesAllocation,
    #[error("Failed to initialize VideoToolbox hardware frames context: {0}")]
    FramesInit(i32),
    #[error("Failed to wrap CVPixelBuffer into an AVFrame")]
    FrameWrap,
}

/// An `AVHWFramesContext` for wrapping externally-owned CVPixelBuffers as
/// `AV_PIX_FMT_VIDEOTOOLBOX` frames. The context never allocates buffers of
/// its own; every frame references a caller-provided CVPixelBuffer.
pub struct VideoToolboxHwFrames {
    device_ctx: *mut AVBufferRef,
    frames_ctx: *mut AVBufferRef,
    width: u32,
    height: u32,
}

// SAFETY: AVBufferRef reference counting is thread-safe, and the wrapped
// contexts carry no thread affinity.
unsafe impl Send for VideoToolboxHwFrames {}

unsafe extern "C" fn release_pixel_buffer(_opaque: *mut c_void, data: *mut u8) {
    unsafe { CFRelease(data as *const c_void) };
}

impl VideoToolboxHwFrames {
    pub fn new(width: u32, height: u32) -> Result<Self, VideoToolboxHwError> {
        unsafe {
            let mut device_ctx: *mut AVBufferRef = null_mut();
            if av_hwdevice_ctx_create(
                &mut device_ctx,
                AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
                null(),
                null_mut(),
                0,
            ) < 0
            {
                return Err(VideoToolboxHwError::DeviceCreation);
            }

            let frames_ctx = av_hwframe_ctx_alloc(device_ctx);
            if frames_ctx.is_null() {
                let mut device_ctx = device_ctx;
                av_buffer_unref(&mut device_ctx);
                return Err(VideoToolboxHwError::FramesAllocation);
            }

            let ctx = (*frames_ctx).data as *mut AVHWFramesContext;
            (*ctx).format = AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX;
            (*ctx).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
            (*ctx).width = width as i32;
            (*ctx).height = height as i32;

            let init_result = av_hwframe_ctx_init(frames_ctx);
            if init_result < 0 {
                let mut frames_ctx = frames_ctx;
                av_buffer_unref(&mut frames_ctx);
                let mut device_ctx = device_ctx;
                av_buffer_unref(&mut device_ctx);
                return Err(VideoToolboxHwError::FramesInit(init_result));
            }

            Ok(Self {
                device_ctx,
                frames_ctx,
                width,
                height,
            })
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Attaches the frames context to an encoder that will be opened with
    /// `AV_PIX_FMT_VIDEOTOOLBOX`. Must run before `avcodec_open2`.
    ///
    /// # Safety
    /// `encoder_ctx` must be a valid, not-yet-opened `AVCodecContext`.
    pub(crate) unsafe fn attach_to_encoder(&self, encoder_ctx: *mut AVCodecContext) {
        unsafe {
            (*encoder_ctx).hw_frames_ctx = av_buffer_ref(self.frames_ctx);
        }
    }

    /// Wraps a retained CVPixelBuffer as an `AV_PIX_FMT_VIDEOTOOLBOX` frame.
    /// The buffer is CFRetained for the frame's lifetime and released when the
    /// frame's backing `AVBufferRef` drops.
    ///
    /// `pixel_buffer` must be a valid `CVPixelBufferRef` whose dimensions
    /// match this context and whose pixel format is biplanar 4:2:0 (`420v` /
    /// `420f`, ffmpeg `NV12`).
    pub fn wrap_pixel_buffer(
        &self,
        pixel_buffer: *mut c_void,
    ) -> Result<ffmpeg::frame::Video, VideoToolboxHwError> {
        if pixel_buffer.is_null() {
            return Err(VideoToolboxHwError::FrameWrap);
        }
        let mut frame = ffmpeg::frame::Video::empty();
        unsafe {
            let ptr = frame.as_mut_ptr();
            let retained = CFRetain(pixel_buffer);
            let buf = av_buffer_create(
                retained as *mut u8,
                size_of::<*mut c_void>(),
                Some(release_pixel_buffer),
                null_mut(),
                0,
            );
            if buf.is_null() {
                CFRelease(retained);
                return Err(VideoToolboxHwError::FrameWrap);
            }
            (*ptr).buf[0] = buf;
            (*ptr).data[3] = retained as *mut u8;
            (*ptr).format = AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32;
            (*ptr).width = self.width as i32;
            (*ptr).height = self.height as i32;
            (*ptr).hw_frames_ctx = av_buffer_ref(self.frames_ctx);
            if (*ptr).hw_frames_ctx.is_null() {
                return Err(VideoToolboxHwError::FrameWrap);
            }
        }
        Ok(frame)
    }
}

impl Drop for VideoToolboxHwFrames {
    fn drop(&mut self) {
        unsafe {
            av_buffer_unref(&mut self.frames_ctx);
            av_buffer_unref(&mut self.device_ctx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hw_frames_context_initializes() {
        ffmpeg::init().ok();
        let frames = VideoToolboxHwFrames::new(1920, 1080).expect("hw frames context");
        assert_eq!(frames.width(), 1920);
        assert_eq!(frames.height(), 1080);
    }
}
