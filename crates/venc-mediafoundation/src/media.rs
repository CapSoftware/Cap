use windows::{
    Win32::Media::MediaFoundation::{
        IMFActivate, IMFAttributes, MF_E_ATTRIBUTENOTFOUND, MFT_ENUM_FLAG, MFT_REGISTER_TYPE_INFO,
        MFTEnumEx,
    },
    core::{Array, GUID, Result},
};

pub fn enumerate_mfts(
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
            let transform_source = mfactivate.clone().unwrap();
            transform_sources.push(transform_source);
        }
    }
    Ok(transform_sources)
}

pub fn get_string_attribute(
    attributes: &IMFAttributes,
    attribute_guid: &GUID,
) -> Result<Option<String>> {
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

// These inlined helpers aren't represented in the metadata

// This is the value for Win7+
pub const MF_VERSION: u32 = 131184;

fn pack_2_u32_as_u64(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

#[allow(non_snake_case)]
unsafe fn MFSetAttribute2UINT32asUINT64(
    attributes: &IMFAttributes,
    key: &GUID,
    high: u32,
    low: u32,
) -> Result<()> {
    unsafe { attributes.SetUINT64(key, pack_2_u32_as_u64(high, low)) }
}

#[allow(non_snake_case)]
pub unsafe fn MFSetAttributeSize(
    attributes: &IMFAttributes,
    key: &GUID,
    width: u32,
    height: u32,
) -> Result<()> {
    unsafe { MFSetAttribute2UINT32asUINT64(attributes, key, width, height) }
}

#[allow(non_snake_case)]
pub unsafe fn MFSetAttributeRatio(
    attributes: &IMFAttributes,
    key: &GUID,
    numerator: u32,
    denominator: u32,
) -> Result<()> {
    unsafe { MFSetAttribute2UINT32asUINT64(attributes, key, numerator, denominator) }
}
