use windows::{
    Win32::Media::MediaFoundation::{
        IMFActivate, IMFAttributes, MF_E_ATTRIBUTENOTFOUND, MFT_ENUM_FLAG, MFT_REGISTER_TYPE_INFO,
        MFTEnumEx,
    },
    core::{Array, GUID, Result},
};
use windows::{
    Win32::Media::MediaFoundation::{
        IMFTransform, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE,
        MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_TRANSCODE_ONLY, MFT_FRIENDLY_NAME_Attribute,
    },
    core::Interface,
};

#[derive(Clone)]
pub struct EncoderDevice {
    source: IMFActivate,
    display_name: String,
}

impl EncoderDevice {
    pub fn enumerate(major_type: GUID, subtype: GUID) -> Result<Vec<EncoderDevice>> {
        let devices = Self::enumerate_with_flags(
            major_type,
            subtype,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_TRANSCODE_ONLY | MFT_ENUM_FLAG_SORTANDFILTER,
        )?;

        if !devices.is_empty() {
            return Ok(devices);
        }

        // Fallback to software implementation if hardware encoding is not available
        Self::enumerate_with_flags(
            major_type,
            subtype,
            MFT_ENUM_FLAG_TRANSCODE_ONLY | MFT_ENUM_FLAG_SORTANDFILTER,
        )
    }

    pub fn enumerate_with_flags(
        major_type: GUID,
        subtype: GUID,
        flags: MFT_ENUM_FLAG,
    ) -> Result<Vec<EncoderDevice>> {
        let output_info = MFT_REGISTER_TYPE_INFO {
            guidMajorType: major_type,
            guidSubtype: subtype,
        };
        let flags = if flags.0 == 0 {
            MFT_ENUM_FLAG_SORTANDFILTER
        } else {
            flags | MFT_ENUM_FLAG_SORTANDFILTER
        };
        let encoders =
            enumerate_mfts(&MFT_CATEGORY_VIDEO_ENCODER, flags, None, Some(&output_info))?;
        let mut encoder_devices = Vec::new();
        for encoder in encoders {
            let display_name = if let Some(display_name) =
                get_string_attribute(&encoder.cast()?, &MFT_FRIENDLY_NAME_Attribute)?
            {
                display_name
            } else {
                "Unknown".to_owned()
            };
            let encoder_device = EncoderDevice {
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

fn enumerate_mfts(
    category: &GUID,
    flags: MFT_ENUM_FLAG,
    input_type: Option<&MFT_REGISTER_TYPE_INFO>,
    output_type: Option<&MFT_REGISTER_TYPE_INFO>,
) -> Result<Vec<IMFActivate>> {
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
            if let Some(transform_source) = mfactivate.clone() {
                transform_sources.push(transform_source);
            }
        }
    }
    Ok(transform_sources)
}

fn get_string_attribute(
    attributes: &IMFAttributes,
    attribute_guid: &GUID,
) -> Result<Option<String>> {
    unsafe {
        match attributes.GetStringLength(attribute_guid) {
            Ok(mut length) => {
                let mut result = vec![0u16; (length + 1) as usize];
                attributes.GetString(attribute_guid, &mut result, Some(&mut length))?;
                result.resize(length as usize, 0);
                Ok(String::from_utf16(&result).ok())
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
