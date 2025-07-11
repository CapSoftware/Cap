use std::{
    ffi::{OsString, c_void},
    ops::Deref,
    os::windows::ffi::OsStringExt,
    ptr::{null, null_mut},
};
use windows::{
    Win32::{
        Foundation::{S_OK, SIZE},
        Media::{
            DirectShow::{
                AMPROPERTY_PIN_CATEGORY, IAMStreamConfig, IAMVideoControl, IBaseFilter,
                ICreateDevEnum, IPin, PIN_DIRECTION, VIDEO_STREAM_CONFIG_CAPS,
            },
            KernelStreaming::{IKsPropertySet, KS_VIDEOINFOHEADER},
            MediaFoundation::{
                AM_MEDIA_TYPE, AMPROPSETID_Pin, CLSID_SystemDeviceEnum,
                CLSID_VideoInputDeviceCategory, MEDIASUBTYPE_ARGB32, MEDIASUBTYPE_I420,
                MEDIASUBTYPE_IYUV, MEDIASUBTYPE_MJPG, MEDIASUBTYPE_NV12, MEDIASUBTYPE_RGB24,
                MEDIASUBTYPE_RGB32, MEDIASUBTYPE_UYVY, MEDIASUBTYPE_YUY2,
            },
        },
        System::{
            Com::{
                CLSCTX_INPROC_SERVER, CoCreateInstance, IEnumMoniker, IErrorLog, IMoniker,
                StructuredStorage::IPropertyBag,
            },
            Variant::{VARIANT, VT_BSTR},
        },
    },
    core::Interface,
};
use windows_core::{GUID, PWSTR};

pub trait IPinExt {
    unsafe fn matches_category(&self, category: GUID) -> bool;
    unsafe fn matches_major_type(&self, major_type: GUID) -> bool;
}

impl IPinExt for IPin {
    unsafe fn matches_category(&self, category: GUID) -> bool {
        let ks_property = self.cast::<IKsPropertySet>().unwrap();
        let mut return_value_size = 0;
        let mut pin_category = GUID::zeroed();
        ks_property
            .Get(
                &AMPROPSETID_Pin,
                AMPROPERTY_PIN_CATEGORY.0 as u32,
                null(),
                0,
                (&mut pin_category) as *mut _ as *mut c_void,
                std::mem::size_of_val(&pin_category) as u32,
                &mut return_value_size,
            )
            .unwrap();

        return_value_size as usize == std::mem::size_of_val(&category) && pin_category == category
    }
    unsafe fn matches_major_type(&self, major_type: GUID) -> bool {
        let mut connection_media_type = AM_MEDIA_TYPE::default();
        self.ConnectionMediaType(&mut connection_media_type)
            .map(|_| connection_media_type.majortype == major_type)
            .unwrap_or(false)
    }
}

pub trait IBaseFilterExt {
    unsafe fn get_pin(
        &self,
        direction: PIN_DIRECTION,
        category: GUID,
        major_type: GUID,
    ) -> Option<IPin>;

    unsafe fn get_pin_by_name(
        &self,
        direction: PIN_DIRECTION,
        name: Option<&PWSTR>,
    ) -> Option<IPin>;
}

impl IBaseFilterExt for IBaseFilter {
    unsafe fn get_pin(
        &self,
        direction: PIN_DIRECTION,
        category: GUID,
        major_type: GUID,
    ) -> Option<IPin> {
        let pin_enum = self.EnumPins().unwrap();

        let _ = pin_enum.Reset();

        let mut pin = [None];
        while pin_enum.Next(&mut pin, None) == S_OK {
            let Some(pin) = pin[0].take() else {
                break;
            };

            let pin_dir = pin.QueryDirection().unwrap();

            if pin_dir == direction {
                if (category == GUID::zeroed() || pin.matches_category(category))
                    && (major_type == GUID::zeroed() || pin.matches_major_type(major_type))
                {
                    return Some(pin);
                }
            }
        }

        None
    }

    unsafe fn get_pin_by_name(
        &self,
        direction: PIN_DIRECTION,
        name: Option<&PWSTR>,
    ) -> Option<IPin> {
        let pin_enum = self.EnumPins().unwrap();

        let _ = pin_enum.Reset();

        dbg!(direction);

        let mut pin = [None];
        while pin_enum.Next(&mut pin, None) == S_OK {
            let Some(pin) = pin[0].take() else {
                break;
            };

            let pin_dir = pin.QueryDirection().unwrap();

            dbg!(pin_dir);

            if pin_dir == direction {
                return Some(pin);
            }
        }

        None
    }
}

pub trait VARIANTExt {
    unsafe fn to_os_string(&self) -> Option<OsString>;
}

impl VARIANTExt for VARIANT {
    unsafe fn to_os_string(&self) -> Option<OsString> {
        (self.Anonymous.Anonymous.vt == VT_BSTR)
            .then(|| OsString::from_wide(self.Anonymous.Anonymous.Anonymous.bstrVal.deref()))
    }
}

pub struct IAMStreamConfigMediaTypes<'a> {
    stream_config: &'a IAMStreamConfig,
    count: u32,
    caps: VIDEO_STREAM_CONFIG_CAPS,
    i: i32,
}

impl<'a> IAMStreamConfigMediaTypes<'a> {
    pub unsafe fn next(&mut self) -> Option<(&'a AM_MEDIA_TYPEVideo, i32)> {
        let i = self.i;

        if i >= self.count as i32 {
            return None;
        }

        self.i += 1;

        let mut media_type = null_mut();

        self.stream_config
            .GetStreamCaps(i, &mut media_type, (&raw mut self.caps).cast::<u8>())
            .unwrap();

        if media_type.is_null() {
            return None;
        }

        Some((&*media_type, i))
    }

    pub fn count(&self) -> u32 {
        self.count
    }
}

pub trait IAMStreamConfigExt {
    unsafe fn media_types(&self) -> IAMStreamConfigMediaTypes;
}

impl IAMStreamConfigExt for IAMStreamConfig {
    unsafe fn media_types(&self) -> IAMStreamConfigMediaTypes {
        let mut count = 0;
        self.GetNumberOfCapabilities(&mut count, &mut 0).unwrap();

        IAMStreamConfigMediaTypes {
            stream_config: &self,
            count: count as u32,
            caps: VIDEO_STREAM_CONFIG_CAPS::default(),
            i: 0,
        }
    }
}

#[allow(non_camel_case_types)]
type AM_MEDIA_TYPEVideo = AM_MEDIA_TYPE;

#[allow(non_camel_case_types)]
pub trait AM_MEDIA_TYPEVideoExt {
    unsafe fn video_info(&self) -> &KS_VIDEOINFOHEADER;
}

impl AM_MEDIA_TYPEVideoExt for AM_MEDIA_TYPEVideo {
    unsafe fn video_info(&self) -> &KS_VIDEOINFOHEADER {
        &*self.pbFormat.cast::<KS_VIDEOINFOHEADER>()
    }
}

#[allow(non_camel_case_types)]
pub trait AM_MEDIA_TYPEExt {
    unsafe fn subtype_str(&self) -> Option<&'static str>;
}

impl AM_MEDIA_TYPEExt for AM_MEDIA_TYPE {
    unsafe fn subtype_str(&self) -> Option<&'static str> {
        Some(match self.subtype {
            t if t == MEDIASUBTYPE_I420 => "i420",
            t if t == MEDIASUBTYPE_IYUV => "iyuv",
            t if t == MEDIASUBTYPE_RGB24 => "rgb24",
            t if t == MEDIASUBTYPE_RGB32 => "rgb32",
            t if t == MEDIASUBTYPE_YUY2 => "yuy2",
            t if t == MEDIASUBTYPE_MJPG => "mjpg",
            t if t == MEDIASUBTYPE_UYVY => "uyvy",
            t if t == MEDIASUBTYPE_ARGB32 => "argb32",
            t if t == MEDIASUBTYPE_NV12 => "nv12",
            _ => return None,
        })
    }
}

pub trait IAMVideoControlExt {
    unsafe fn time_per_frame_list<'a>(&self, pin: &'a IPin, i: i32, dimensions: SIZE) -> &'a [i64];
}

impl IAMVideoControlExt for IAMVideoControl {
    unsafe fn time_per_frame_list<'a>(&self, pin: &'a IPin, i: i32, dimensions: SIZE) -> &'a [i64] {
        let mut time_per_frame_list = null_mut();
        let mut list_size = 0;

        self.GetFrameRateList(pin, i, dimensions, &mut list_size, &mut time_per_frame_list)
            .unwrap();

        if list_size > 0 && !time_per_frame_list.is_null() {
            return std::slice::from_raw_parts(time_per_frame_list, list_size as usize);
        }

        &[]
    }
}

pub trait IPropertyBagExt {
    unsafe fn read<P0, P2>(&self, pszpropname: P0, perrorlog: P2) -> windows_core::Result<VARIANT>
    where
        P0: windows_core::Param<windows_core::PCWSTR>,
        P2: windows_core::Param<IErrorLog>;
}

impl IPropertyBagExt for IPropertyBag {
    unsafe fn read<P0, P2>(&self, pszpropname: P0, perrorlog: P2) -> windows_core::Result<VARIANT>
    where
        P0: windows_core::Param<windows_core::PCWSTR>,
        P2: windows_core::Param<IErrorLog>,
    {
        let mut ret = VARIANT::default();
        self.Read(pszpropname, &mut ret, perrorlog)?;
        Ok(ret)
    }
}

type VideoInputDeviceIMoniker = IMoniker;

pub struct VideoInputDeviceEnumerator {
    enum_moniker: IEnumMoniker,
    moniker: [Option<VideoInputDeviceIMoniker>; 1],
}

impl VideoInputDeviceEnumerator {
    pub unsafe fn new() -> windows_core::Result<Self> {
        let create_device_enum: ICreateDevEnum = CoCreateInstance(
            &CLSID_SystemDeviceEnum,
            None::<&windows_core::IUnknown>,
            CLSCTX_INPROC_SERVER,
        )?;

        let mut enum_moniker = None;

        create_device_enum.CreateClassEnumerator(
            &CLSID_VideoInputDeviceCategory,
            &mut enum_moniker,
            0,
        )?;

        Ok(Self {
            enum_moniker: enum_moniker.unwrap(),
            moniker: [None],
        })
    }

    pub unsafe fn next(&mut self) -> Option<VideoInputDeviceIMoniker> {
        if self.enum_moniker.Next(&mut self.moniker, None) == S_OK {
            return self.moniker[0].take();
        }

        None
    }

    pub unsafe fn to_vec(mut self) -> Vec<VideoInputDeviceIMoniker> {
        let mut monikers = Vec::new();
        while let Some(moniker) = self.next() {
            monikers.push(moniker);
        }
        monikers
    }
}
