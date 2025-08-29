use windows::{
    Win32::Media::MediaFoundation::{
        IMFActivate, IMFTransform, MFMediaType_Video, MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_TRANSCODE_ONLY,
        MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MFVideoFormat_H264,
    },
    core::{Interface, Result},
};

use crate::media::{enumerate_mfts, get_string_attribute};

#[derive(Clone)]
pub struct VideoEncoderDevice {
    source: IMFActivate,
    display_name: String,
}

impl VideoEncoderDevice {
    pub fn enumerate() -> Result<Vec<VideoEncoderDevice>> {
        let output_info = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        let encoders = enumerate_mfts(
            &MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_TRANSCODE_ONLY | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&output_info),
        )?;
        let mut encoder_devices = Vec::new();
        for encoder in encoders {
            let display_name = if let Some(display_name) =
                get_string_attribute(&encoder.cast()?, &MFT_FRIENDLY_NAME_Attribute)?
            {
                display_name
            } else {
                "Unknown".to_owned()
            };
            let encoder_device = VideoEncoderDevice {
                source: encoder,
                display_name,
            };
            encoder_devices.push(encoder_device);
        }
        Ok(encoder_devices)
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn create_transform(&self) -> Result<IMFTransform> {
        unsafe { self.source.ActivateObject() }
    }
}
