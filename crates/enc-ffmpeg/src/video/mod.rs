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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum VideoCodec {
    #[default]
    H264,
    Hevc,
}

impl VideoCodec {
    pub fn id(self) -> ffmpeg::codec::Id {
        match self {
            Self::H264 => ffmpeg::codec::Id::H264,
            Self::Hevc => ffmpeg::codec::Id::HEVC,
        }
    }

    /// The encoder for this codec that stands in for an H.264 encoder name.
    ///
    /// HEVC has no software encoder: FFmpeg 7.1's libx265 wrapper hands
    /// x265 4.0 output pictures it never initialised, and x265 frees pointers
    /// out of them as soon as it returns a frame. The FFmpeg builds Cap ships
    /// are 7.1 with x265 4.0, so libx265 crashes on every export. FFmpeg 8
    /// zero-initialises those pictures.
    pub(crate) fn encoder_name(self, h264_name: &'static str) -> Option<&'static str> {
        match self {
            Self::H264 => Some(h264_name),
            Self::Hevc => match h264_name {
                "h264_videotoolbox" => Some("hevc_videotoolbox"),
                "h264_nvenc" => Some("hevc_nvenc"),
                "h264_qsv" => Some("hevc_qsv"),
                "h264_amf" => Some("hevc_amf"),
                "h264_mf" => Some("hevc_mf"),
                "h264_vaapi" => Some("hevc_vaapi"),
                _ => None,
            },
        }
    }
}

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
