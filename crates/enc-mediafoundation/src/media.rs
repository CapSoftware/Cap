use windows::{
    Win32::Media::MediaFoundation::IMFAttributes,
    core::{GUID, Result},
};

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
