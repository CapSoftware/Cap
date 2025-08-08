use std::{
    cell::Cell,
    ptr::{null, null_mut},
};

use ffmpeg::{
    codec,
    frame::{self, Video},
};
use ffmpeg_sys_next::{
    AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX, AVBufferRef, AVCodecContext, AVCodecHWConfig,
    AVHWDeviceType, AVPixelFormat, av_buffer_ref, av_buffer_unref, av_hwdevice_ctx_create,
    av_hwframe_transfer_data, avcodec_get_hw_config,
};

thread_local! {
    static HW_PIX_FMT: Cell<AVPixelFormat> = const { Cell::new(AVPixelFormat::AV_PIX_FMT_NONE) };
}

unsafe extern "C" fn get_format(
    _: *mut AVCodecContext,
    pix_fmts: *const AVPixelFormat,
) -> AVPixelFormat {
    unsafe {
        let mut fmt = pix_fmts;

        loop {
            if *fmt == AVPixelFormat::AV_PIX_FMT_NONE {
                break;
            }

            if *fmt == HW_PIX_FMT.get() {
                return *fmt;
            }

            fmt = fmt.offset(1);
        }

        AVPixelFormat::AV_PIX_FMT_NONE
    }
}

pub struct HwDevice {
    pub device_type: AVHWDeviceType,
    ctx: *mut AVBufferRef,
}

impl HwDevice {
    pub fn get_hwframe(&self, src: &Video) -> Option<Video> {
        unsafe {
            if src.format() == HW_PIX_FMT.get().into() {
                let mut sw_frame = frame::Video::empty();

                if av_hwframe_transfer_data(sw_frame.as_mut_ptr(), src.as_ptr(), 0) >= 0 {
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

            if av_hwdevice_ctx_create(&mut hw_device_ctx, device_type, null(), null_mut(), 0) < 0 {
                return Err("failed to create hw device context");
            }

            HW_PIX_FMT.set((*hw_config).pix_fmt);

            let context = self.as_mut_ptr();

            (*context).get_format = Some(get_format);
            (*context).hw_device_ctx = av_buffer_ref(hw_device_ctx);

            Ok(HwDevice {
                device_type,
                ctx: hw_device_ctx,
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
