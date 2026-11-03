//! H.264 on Linux AMD and Intel GPUs through VA-API.
//!
//! `h264_vaapi` only encodes frames that already live in a VA surface, so the
//! encoder gets a pool of NV12 surfaces on a render node and each software
//! NV12 frame is uploaded into one just before it is sent.

use std::{
    ffi::CString,
    path::{Path, PathBuf},
    ptr,
};

use ffmpeg::{ffi, frame};

pub(crate) struct VaapiFrames {
    device: *mut ffi::AVBufferRef,
    frames: *mut ffi::AVBufferRef,
    surface: frame::Video,
}

// The buffers are reference counted by FFmpeg and only touched from the
// thread that owns the encoder.
unsafe impl Send for VaapiFrames {}

impl VaapiFrames {
    pub(crate) fn open(node: &Path, width: u32, height: u32) -> Result<Self, String> {
        let path = CString::new(node.as_os_str().as_encoded_bytes())
            .map_err(|_| "render node path has a NUL byte".to_string())?;
        let mut device = ptr::null_mut();
        let ret = unsafe {
            ffi::av_hwdevice_ctx_create(
                &mut device,
                ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
                path.as_ptr(),
                ptr::null_mut(),
                0,
            )
        };
        if ret < 0 {
            return Err(format!("VA-API device: {}", ffmpeg::Error::from(ret)));
        }
        let mut frames = unsafe { ffi::av_hwframe_ctx_alloc(device) };
        if frames.is_null() {
            unsafe { ffi::av_buffer_unref(&mut device) };
            return Err("VA-API frame pool allocation failed".to_string());
        }
        unsafe {
            let context = (*frames).data.cast::<ffi::AVHWFramesContext>();
            (*context).format = ffi::AVPixelFormat::AV_PIX_FMT_VAAPI;
            (*context).sw_format = ffi::AVPixelFormat::AV_PIX_FMT_NV12;
            (*context).width = width as i32;
            (*context).height = height as i32;
            (*context).initial_pool_size = 20;
        }
        let ret = unsafe { ffi::av_hwframe_ctx_init(frames) };
        if ret < 0 {
            unsafe {
                ffi::av_buffer_unref(&mut frames);
                ffi::av_buffer_unref(&mut device);
            }
            return Err(format!(
                "VA-API NV12 surfaces: {}",
                ffmpeg::Error::from(ret)
            ));
        }
        Ok(Self {
            device,
            frames,
            surface: frame::Video::empty(),
        })
    }

    /// # Safety
    /// `encoder` must be an unopened codec context.
    pub(crate) unsafe fn attach(&self, encoder: *mut ffi::AVCodecContext) {
        unsafe { (*encoder).hw_frames_ctx = ffi::av_buffer_ref(self.frames) };
    }

    pub(crate) fn upload(&mut self, source: &frame::Video) -> Result<&frame::Video, ffmpeg::Error> {
        unsafe {
            let surface = self.surface.as_mut_ptr();
            ffi::av_frame_unref(surface);
            let ret = ffi::av_hwframe_get_buffer(self.frames, surface, 0);
            if ret < 0 {
                return Err(ffmpeg::Error::from(ret));
            }
            let ret = ffi::av_hwframe_transfer_data(surface, source.as_ptr(), 0);
            if ret < 0 {
                return Err(ffmpeg::Error::from(ret));
            }
            let ret = ffi::av_frame_copy_props(surface, source.as_ptr());
            if ret < 0 {
                return Err(ffmpeg::Error::from(ret));
            }
        }
        Ok(&self.surface)
    }
}

impl Drop for VaapiFrames {
    fn drop(&mut self) {
        unsafe {
            ffi::av_frame_unref(self.surface.as_mut_ptr());
            ffi::av_buffer_unref(&mut self.frames);
            ffi::av_buffer_unref(&mut self.device);
        }
    }
}

/// Render nodes whose kernel driver has a VA-API driver: not NVIDIA (whose
/// encoder is NVENC), and not the virtual vgem and vkms devices.
pub(crate) fn render_nodes() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/dev/dri") else {
        return Vec::new();
    };
    let mut nodes = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("renderD"))
        })
        .filter(|path| vaapi_driver(kernel_driver(path).as_deref()))
        .collect::<Vec<_>>();
    nodes.sort();
    nodes
}

fn kernel_driver(node: &Path) -> Option<String> {
    let name = node.file_name()?;
    let link =
        std::fs::read_link(Path::new("/sys/class/drm").join(name).join("device/driver")).ok()?;
    Some(link.file_name()?.to_string_lossy().into_owned())
}

fn vaapi_driver(driver: Option<&str>) -> bool {
    match driver {
        None => false,
        Some(driver) => !(driver.starts_with("nvidia") || matches!(driver, "vgem" | "vkms")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_gpus_with_a_va_api_driver_are_tried() {
        for driver in ["amdgpu", "radeon", "i915", "xe", "nouveau", "virtio-pci"] {
            assert!(vaapi_driver(Some(driver)), "{driver}");
        }
        for driver in ["nvidia", "nvidia-drm", "vgem", "vkms"] {
            assert!(!vaapi_driver(Some(driver)), "{driver}");
        }
        assert!(!vaapi_driver(None));
    }
}
