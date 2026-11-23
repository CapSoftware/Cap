//! `data[0]` is the texture pointer and `data[1]` is the array index.
//! FFmpeg releases the device pointer stored on the hwdevice context, so that
//! pointer is AddRef'd before `av_hwdevice_ctx_init`.

use std::ffi::c_void;
use std::ptr::null_mut;

use ffmpeg::sys::{
    AVBufferRef, AVCodecContext, AVHWDeviceContext, AVHWDeviceType, AVHWFramesContext,
    AVPixelFormat, av_buffer_create, av_buffer_ref, av_buffer_unref, av_hwdevice_ctx_alloc,
    av_hwdevice_ctx_init, av_hwframe_ctx_alloc, av_hwframe_ctx_init,
};
use windows::core::{IUnknown, Interface};

const BIND_SHADER_RESOURCE: u32 = 0x8;
const BIND_RENDER_TARGET: u32 = 0x20;
const BIND_VIDEO_ENCODER: u32 = 0x400;

#[repr(C)]
struct D3d11FramesHwctx {
    texture: *mut c_void,
    bind_flags: u32,
    misc_flags: u32,
}

#[derive(thiserror::Error, Debug)]
pub enum D3d11HwError {
    #[error("Failed to create a D3D11 hardware device context")]
    DeviceCreation,
    #[error("Failed to allocate a D3D11 hardware frames context")]
    FramesAllocation,
    #[error("Failed to initialize a D3D11 hardware frames context: {0}")]
    FramesInit(i32),
    #[error("Failed to wrap a D3D11 texture into an AVFrame")]
    FrameWrap,
}

pub struct D3d11TextureLifetime {
    pub data: *mut c_void,
    pub free: unsafe extern "C" fn(*mut c_void),
}

struct ExtraRelease {
    free: unsafe extern "C" fn(*mut c_void),
    data: *mut c_void,
}

pub(crate) struct D3d11HwFrames {
    device_ctx: *mut AVBufferRef,
    frames_ctx: *mut AVBufferRef,
    width: u32,
    height: u32,
}

unsafe impl Send for D3d11HwFrames {}
unsafe impl Sync for D3d11HwFrames {}

unsafe fn add_ref(ptr: *mut c_void) -> *mut c_void {
    unsafe {
        let owned = IUnknown::from_raw(ptr);
        let extra = owned.clone();
        std::mem::forget(extra);
        std::mem::forget(owned);
    }
    ptr
}

unsafe fn release(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(IUnknown::from_raw(ptr));
    }
}

unsafe extern "C" fn release_texture(opaque: *mut c_void, data: *mut u8) {
    unsafe {
        release(data as *mut c_void);
        if !opaque.is_null() {
            let extra = Box::from_raw(opaque as *mut ExtraRelease);
            (extra.free)(extra.data);
        }
    }
}

fn fail_lifetime(lifetime: Option<D3d11TextureLifetime>) {
    if let Some(lifetime) = lifetime {
        unsafe { (lifetime.free)(lifetime.data) };
    }
}

impl D3d11HwFrames {
    /// # Safety
    /// `device` must be a valid `ID3D11Device` that stays alive until this
    /// value is dropped. Textures wrapped later must belong to that device.
    pub(crate) unsafe fn new(
        device: *mut c_void,
        width: u32,
        height: u32,
    ) -> Result<Self, D3d11HwError> {
        if device.is_null() || width == 0 || height == 0 {
            return Err(D3d11HwError::DeviceCreation);
        }
        unsafe {
            let device_ctx = av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
            if device_ctx.is_null() {
                return Err(D3d11HwError::DeviceCreation);
            }
            let hw = (*device_ctx).data as *mut AVHWDeviceContext;
            let d3d_device = (*hw).hwctx as *mut *mut c_void;
            if hw.is_null() || d3d_device.is_null() {
                let mut device_ctx = device_ctx;
                av_buffer_unref(&mut device_ctx);
                return Err(D3d11HwError::DeviceCreation);
            }
            *d3d_device = add_ref(device);
            if av_hwdevice_ctx_init(device_ctx) < 0 {
                let mut device_ctx = device_ctx;
                av_buffer_unref(&mut device_ctx);
                return Err(D3d11HwError::DeviceCreation);
            }

            let frames_ctx = av_hwframe_ctx_alloc(device_ctx);
            if frames_ctx.is_null() {
                let mut device_ctx = device_ctx;
                av_buffer_unref(&mut device_ctx);
                return Err(D3d11HwError::FramesAllocation);
            }

            let ctx = (*frames_ctx).data as *mut AVHWFramesContext;
            (*ctx).format = AVPixelFormat::AV_PIX_FMT_D3D11;
            (*ctx).sw_format = AVPixelFormat::AV_PIX_FMT_RGBA;
            (*ctx).width = width as i32;
            (*ctx).height = height as i32;
            (*ctx).initial_pool_size = 0;
            let frames_hw = (*ctx).hwctx as *mut D3d11FramesHwctx;
            if !frames_hw.is_null() {
                (*frames_hw).bind_flags =
                    BIND_SHADER_RESOURCE | BIND_RENDER_TARGET | BIND_VIDEO_ENCODER;
            }

            let init_result = av_hwframe_ctx_init(frames_ctx);
            if init_result < 0 {
                let mut frames_ctx = frames_ctx;
                av_buffer_unref(&mut frames_ctx);
                let mut device_ctx = device_ctx;
                av_buffer_unref(&mut device_ctx);
                return Err(D3d11HwError::FramesInit(init_result));
            }

            Ok(Self {
                device_ctx,
                frames_ctx,
                width,
                height,
            })
        }
    }

    /// # Safety
    /// `encoder_ctx` must be a valid, not-yet-opened `AVCodecContext`.
    pub(crate) unsafe fn attach_to_encoder(&self, encoder_ctx: *mut AVCodecContext) {
        unsafe {
            (*encoder_ctx).hw_frames_ctx = av_buffer_ref(self.frames_ctx);
        }
    }

    /// # Safety
    /// `texture` must be a 2D `ID3D11Texture2D` on this device, RGBA
    /// (`DXGI_FORMAT_R8G8B8A8_UNORM`), matching `width` and `height`.
    /// `lifetime.free` runs once, on whichever thread drops the frame.
    pub(crate) unsafe fn wrap_texture(
        &self,
        texture: *mut c_void,
        lifetime: Option<D3d11TextureLifetime>,
    ) -> Result<ffmpeg::frame::Video, D3d11HwError> {
        if texture.is_null() {
            fail_lifetime(lifetime);
            return Err(D3d11HwError::FrameWrap);
        }
        let mut frame = ffmpeg::frame::Video::empty();
        unsafe {
            let retained = add_ref(texture);
            let opaque = match lifetime {
                Some(lifetime) => Box::into_raw(Box::new(ExtraRelease {
                    free: lifetime.free,
                    data: lifetime.data,
                })) as *mut c_void,
                None => null_mut(),
            };
            let buf = av_buffer_create(retained as *mut u8, 1, Some(release_texture), opaque, 0);
            if buf.is_null() {
                release(retained);
                if !opaque.is_null() {
                    let extra = Box::from_raw(opaque as *mut ExtraRelease);
                    (extra.free)(extra.data);
                }
                return Err(D3d11HwError::FrameWrap);
            }
            let ptr = frame.as_mut_ptr();
            (*ptr).buf[0] = buf;
            (*ptr).data[0] = retained as *mut u8;
            (*ptr).data[1] = null_mut();
            (*ptr).format = AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
            (*ptr).width = self.width as i32;
            (*ptr).height = self.height as i32;
            (*ptr).hw_frames_ctx = av_buffer_ref(self.frames_ctx);
            if (*ptr).hw_frames_ctx.is_null() {
                return Err(D3d11HwError::FrameWrap);
            }
        }
        Ok(frame)
    }
}

impl Drop for D3d11HwFrames {
    fn drop(&mut self) {
        unsafe {
            av_buffer_unref(&mut self.frames_ctx);
            av_buffer_unref(&mut self.device_ctx);
        }
    }
}
