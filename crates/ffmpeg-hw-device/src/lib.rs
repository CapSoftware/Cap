use std::{
    cell::Cell,
    ptr::{null, null_mut},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use ffmpeg::{
    codec,
    frame::{self, Video},
    sys::{
        AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX, AVBufferRef, AVCodecContext, AVCodecHWConfig,
        AVHWDeviceType, AVPixelFormat, av_buffer_ref, av_buffer_unref, av_dict_free, av_dict_set,
        av_hwdevice_ctx_create, av_hwframe_transfer_data, avcodec_default_get_format,
        avcodec_get_hw_config,
    },
};
use tracing::warn;

thread_local! {
    static HW_PIX_FMT: Cell<AVPixelFormat> = const { Cell::new(AVPixelFormat::AV_PIX_FMT_NONE) };
}

unsafe extern "C" fn get_format(
    ctx: *mut AVCodecContext,
    pix_fmts: *const AVPixelFormat,
) -> AVPixelFormat {
    unsafe {
        let mut fmt = pix_fmts;

        loop {
            if *fmt == AVPixelFormat::AV_PIX_FMT_NONE {
                break;
            }

            if *fmt == HW_PIX_FMT.get() {
                set_software_fallback(ctx, false);
                return *fmt;
            }

            fmt = fmt.offset(1);
        }

        // When the hardware format's setup fails (a busy or reset media
        // engine), FFmpeg drops it from the list and asks again. Choosing
        // nothing here would fail every packet, so take FFmpeg's default
        // software format and keep decoding on the CPU.
        warn!(
            hw_pix_fmt = ?HW_PIX_FMT.get(),
            "Hardware decoder setup failed, falling back to software decode"
        );
        set_software_fallback(ctx, true);
        avcodec_default_get_format(ctx, pix_fmts)
    }
}

/// Records `get_format`'s latest choice in the [`HwDevice`] flag that
/// [`install_get_format`] put in the codec context's `opaque`.
unsafe fn set_software_fallback(ctx: *mut AVCodecContext, software: bool) {
    unsafe {
        if let Some(flag) = (*ctx).opaque.cast::<AtomicBool>().cast_const().as_ref() {
            flag.store(software, Ordering::Relaxed);
        }
    }
}

/// Points the codec context at [`get_format`] and at the flag it records the
/// chosen format in. The flag outlives the context as long as the context is
/// freed before the [`HwDevice`] holding the flag.
unsafe fn install_get_format(context: *mut AVCodecContext, software_fallback: &Arc<AtomicBool>) {
    unsafe {
        (*context).get_format = Some(get_format);
        (*context).opaque = Arc::as_ptr(software_fallback).cast_mut().cast();
    }
}

pub struct HwDevice {
    pub device_type: AVHWDeviceType,
    ctx: *mut AVBufferRef,
    software_fallback: Arc<AtomicBool>,
}

fn linux_gpu_frames() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("CAP_LINUX_GPU_FRAMES").as_deref() == Ok("1"))
}

impl HwDevice {
    /// Whether FFmpeg took a software format because the hardware setup
    /// failed, so the decoder is running on the CPU despite this device.
    pub fn is_software_fallback(&self) -> bool {
        self.software_fallback.load(Ordering::Relaxed)
    }

    pub fn get_hwframe(&self, src: &Video) -> Option<Video> {
        // Linux GPU render hosts keep CUDA frames on the device; the renderer
        // copies them device-to-device instead of via system memory.
        if self.device_type == AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA && linux_gpu_frames() {
            return None;
        }
        unsafe {
            if src.format() == HW_PIX_FMT.get().into() {
                let mut sw_frame = frame::Video::empty();

                if av_hwframe_transfer_data(sw_frame.as_mut_ptr(), src.as_ptr(), 0) >= 0 {
                    sw_frame.set_pts(src.pts());
                    // The transfer copies pixels only. Keep the colour tags so
                    // consumers convert hardware-decoded frames with the same
                    // matrix as software-decoded ones.
                    let (dst, src) = (&mut *sw_frame.as_mut_ptr(), &*src.as_ptr());
                    dst.color_range = src.color_range;
                    dst.color_primaries = src.color_primaries;
                    dst.color_trc = src.color_trc;
                    dst.colorspace = src.colorspace;
                    dst.chroma_location = src.chroma_location;
                    return Some(sw_frame);
                };
            }
        }

        None
    }
}

impl Drop for HwDevice {
    fn drop(&mut self) {
        unsafe {
            av_buffer_unref(&mut self.ctx);
        }
    }
}

pub trait CodecContextExt {
    fn try_use_hw_device(&mut self, device_type: AVHWDeviceType) -> Result<HwDevice, &'static str>;
}

impl CodecContextExt for codec::decoder::decoder::Decoder {
    fn try_use_hw_device(&mut self, device_type: AVHWDeviceType) -> Result<HwDevice, &'static str> {
        let codec = self.codec().ok_or("no codec")?;

        unsafe {
            let Some(hw_config) = codec.hw_configs().find(|&config| {
                (*config).device_type == device_type
                    && (*config).methods & (AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX as i32) == 1
            }) else {
                return Err("no hw config");
            };

            let mut hw_device_ctx = null_mut();

            let gpu_frames =
                device_type == AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA && linux_gpu_frames();
            let mut options = null_mut();
            if gpu_frames {
                // Share the device's primary CUDA context with the renderer's
                // Vulkan interop and NVENC, so device pointers work across all.
                av_dict_set(&mut options, c"primary_ctx".as_ptr(), c"1".as_ptr(), 0);
            }
            let created =
                av_hwdevice_ctx_create(&mut hw_device_ctx, device_type, null(), options, 0);
            av_dict_free(&mut options);
            if created < 0 {
                return Err("failed to create hw device context");
            }
            if gpu_frames {
                // Decoded surfaces now live in the frame cache instead of being
                // downloaded at once, so NVDEC's pool needs headroom. NVDEC
                // caps a decoder at 32 surfaces including the DPB (~16).
                (*self.as_mut_ptr()).extra_hw_frames = 12;
            }

            HW_PIX_FMT.set((*hw_config).pix_fmt);

            let context = self.as_mut_ptr();
            let software_fallback = Arc::new(AtomicBool::new(false));

            install_get_format(context, &software_fallback);
            (*context).hw_device_ctx = av_buffer_ref(hw_device_ctx);

            Ok(HwDevice {
                device_type,
                ctx: hw_device_ctx,
                software_fallback,
            })
        }
    }
}

pub trait CodecExt {
    fn hw_configs(&self) -> impl Iterator<Item = *const AVCodecHWConfig>;
}

impl CodecExt for codec::codec::Codec {
    fn hw_configs(&self) -> impl Iterator<Item = *const AVCodecHWConfig> {
        let mut i = 0;

        std::iter::from_fn(move || {
            let config = unsafe { avcodec_get_hw_config(self.as_ptr(), i) };
            if config.is_null() {
                return None;
            }
            i += 1;
            Some(config)
        })
    }
}

// impl CodecContextExt for codec::encoder::video::Video {
//     fn try_use_hw_device(
//         &mut self,
//         device_type: AVHWDeviceType,
//         pix_fmt: Pixel,
//     ) -> Result<HwDevice, &'static str> {
//         unsafe {
//             let mut hw_device_ctx = null_mut();
//             if av_hwdevice_ctx_create(&mut hw_device_ctx, device_type, null(), null_mut(), 0) < 0 {
//                 return Err("failed to create hw device context");
//             }

//             let hw_frames_ref = av_hwframe_ctx_alloc(hw_device_ctx);
//             let frames_ctx = (*hw_frames_ref).data as *mut AVHWFramesContext;
//             (*frames_ctx).format = self.format().into();
//             (*frames_ctx).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
//             (*frames_ctx).width = self.width() as i32;
//             (*frames_ctx).height = self.height() as i32;
//             (*frames_ctx).initial_pool_size = 20;

//             av_hwframe_ctx_init(hw_frames_ref);

//             (*self.as_mut().as_mut_ptr()).hw_frames_ctx = av_buffer_ref(hw_frames_ref);

//             Ok(HwDevice {
//                 device_type,
//                 ctx: hw_device_ctx,
//                 pix_fmt,
//             })
//         }
//     }
// }

#[cfg(test)]
mod tests {
    use super::*;
    use ffmpeg::sys::{avcodec_alloc_context3, avcodec_free_context};

    #[test]
    fn get_format_falls_back_to_software_when_hardware_setup_fails() {
        HW_PIX_FMT.set(AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX);
        let offered = [
            AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX,
            AVPixelFormat::AV_PIX_FMT_YUV420P,
            AVPixelFormat::AV_PIX_FMT_NONE,
        ];
        let device = HwDevice {
            device_type: AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
            ctx: null_mut(),
            software_fallback: Arc::new(AtomicBool::new(false)),
        };
        unsafe {
            let mut ctx = avcodec_alloc_context3(null());
            install_get_format(ctx, &device.software_fallback);
            assert_eq!(
                get_format(ctx, offered.as_ptr()),
                AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX
            );
            assert!(!device.is_software_fallback());
            // FFmpeg drops a hardware format whose setup failed and asks again.
            assert_eq!(
                get_format(ctx, offered[1..].as_ptr()),
                AVPixelFormat::AV_PIX_FMT_YUV420P
            );
            assert!(device.is_software_fallback());
            avcodec_free_context(&mut ctx);
        }
    }
}
