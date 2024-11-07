use std::{
    cell::Cell,
    ptr::{null, null_mut},
};

use ffmpeg::{
    codec,
    format::Pixel,
    frame::{self, Video},
};
use ffmpeg_sys_next::{
    av_buffer_ref, av_buffer_unref, av_hwdevice_ctx_create, av_hwframe_transfer_data,
    avcodec_get_hw_config, AVBufferRef, AVCodecContext, AVHWDeviceType, AVPixelFormat,
    AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX,
};

thread_local! {
    static HW_PIX_FMT: Cell<AVPixelFormat> = const { Cell::new(AVPixelFormat::AV_PIX_FMT_NONE) };
}

unsafe extern "C" fn get_format(
    _: *mut AVCodecContext,
    pix_fmts: *const AVPixelFormat,
) -> AVPixelFormat {
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

pub struct HwDevice {
    pub device_type: AVHWDeviceType,
    pub pix_fmt: Pixel,
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
    fn try_use_hw_device(
        &mut self,
        device_type: AVHWDeviceType,
        pix_fmt: Pixel,
    ) -> Result<HwDevice, &'static str>;
}

impl CodecContextExt for codec::decoder::decoder::Decoder {
    fn try_use_hw_device(
        &mut self,
        device_type: AVHWDeviceType,
        pix_fmt: Pixel,
    ) -> Result<HwDevice, &'static str> {
        let codec = self.codec().ok_or("no codec")?;

        unsafe {
            let mut i = 0;
            loop {
                let config = avcodec_get_hw_config(codec.as_ptr(), i);
                if config.is_null() {
                    return Err("no hw config");
                }

                if (*config).methods & (AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX as i32) == 1
                    && (*config).device_type == AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX
                {
                    HW_PIX_FMT.set((*config).pix_fmt);
                    break;
                }

                i += 1;
            }

            let context = self.as_mut_ptr();

            (*context).get_format = Some(get_format);

            let mut hw_device_ctx = null_mut();

            if av_hwdevice_ctx_create(&mut hw_device_ctx, device_type, null(), null_mut(), 0) < 0 {
                return Err("failed to create hw device context");
            }

            (*context).hw_device_ctx = av_buffer_ref(hw_device_ctx);

            Ok(HwDevice {
                device_type,
                ctx: hw_device_ctx,
                pix_fmt,
            })
        }
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
