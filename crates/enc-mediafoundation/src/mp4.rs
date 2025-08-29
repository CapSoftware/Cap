use cap_media_info::{AudioInfo, PlanarData, VideoInfo};
use windows::{
    Win32::Media::MediaFoundation::*,
    core::{Array, GUID, Interface},
};

pub struct MP4Encoder {}

impl MP4Encoder {
    pub fn new(video_config: VideoInfo) -> Self {
        let encoder_device = VideoEncoderDevice::enumerate().unwrap().swap_remove(0);

        MP4Encoder {}
    }
}

#[derive(Clone)]
struct VideoEncoderDevice {
    source: IMFActivate,
    display_name: String,
}

impl VideoEncoderDevice {
    pub fn enumerate() -> windows::core::Result<Vec<VideoEncoderDevice>> {
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

    pub fn create_transform(&self) -> windows::core::Result<IMFTransform> {
        unsafe { self.source.ActivateObject() }
    }
}

pub fn enumerate_mfts(
    category: &GUID,
    flags: MFT_ENUM_FLAG,
    input_type: Option<&MFT_REGISTER_TYPE_INFO>,
    output_type: Option<&MFT_REGISTER_TYPE_INFO>,
) -> windows::core::Result<Vec<IMFActivate>> {
    let mut transform_sources = Vec::new();
    let mfactivate_list = unsafe {
        let mut data = std::ptr::null_mut();
        let mut len = 0;
        MFTEnumEx(
            *category,
            flags,
            input_type.map(|info| info as *const _),
            output_type.map(|info| info as *const _),
            &mut data,
            &mut len,
        )?;
        Array::<IMFActivate>::from_raw_parts(data as _, len)
    };
    if !mfactivate_list.is_empty() {
        for mfactivate in mfactivate_list.as_slice() {
            let transform_source = mfactivate.clone().unwrap();
            transform_sources.push(transform_source);
        }
    }
    Ok(transform_sources)
}

pub fn get_string_attribute(
    attributes: &IMFAttributes,
    attribute_guid: &GUID,
) -> windows::core::Result<Option<String>> {
    unsafe {
        match attributes.GetStringLength(attribute_guid) {
            Ok(mut length) => {
                let mut result = vec![0u16; (length + 1) as usize];
                attributes.GetString(attribute_guid, &mut result, Some(&mut length))?;
                result.resize(length as usize, 0);
                Ok(Some(String::from_utf16(&result).unwrap()))
            }
            Err(error) => {
                if error.code() == MF_E_ATTRIBUTENOTFOUND {
                    Ok(None)
                } else {
                    Err(error)
                }
            }
        }
    }
}
