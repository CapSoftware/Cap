use ffmpeg::frame;

pub mod colour;
pub mod h264;
pub mod h264_packet;
pub mod hevc;
mod packed_yuv;
pub mod prores;
mod rgb_to_yuv;
#[cfg(target_os = "linux")]
pub(crate) mod vaapi;
#[cfg(target_os = "macos")]
pub mod videotoolbox_hw;

/// Hands an encoder the frame it takes: a GPU surface for encoders that only
/// encode those (VA-API), the software frame itself for every other.
#[derive(Default)]
pub(crate) struct HwUpload {
    #[cfg(target_os = "linux")]
    pub(crate) vaapi: Option<vaapi::VaapiFrames>,
}

impl HwUpload {
    pub(crate) fn frame<'a>(
        &'a mut self,
        frame: &'a frame::Video,
    ) -> Result<&'a frame::Video, ffmpeg::Error> {
        #[cfg(target_os = "linux")]
        if let Some(vaapi) = &mut self.vaapi {
            return vaapi.upload(frame);
        }
        Ok(frame)
    }
}

pub(crate) fn convert_or_scale(
    src: &frame::Video,
    dst: &mut frame::Video,
    scaler: &mut ffmpeg::software::scaling::Context,
) -> Result<(), ffmpeg::Error> {
    if packed_yuv::try_convert(src, dst) || rgb_to_yuv::try_convert(src, dst) {
        Ok(())
    } else {
        scaler.run(src, dst)
    }
}
