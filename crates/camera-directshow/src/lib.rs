#![cfg(windows)]

use std::{
    cell::RefCell,
    ffi::{OsString, c_void},
    mem::ManuallyDrop,
    ops::Deref,
    os::windows::ffi::OsStringExt,
    ptr::{self, null, null_mut},
    time::Duration,
};
use tracing::trace;
use windows::{
    Win32::{
        Foundation::*,
        Media::{
            DirectShow::*,
            KernelStreaming::{IKsPropertySet, KS_BITMAPINFOHEADER, KS_VIDEOINFOHEADER},
            MediaFoundation::*,
        },
        System::{
            Com::{StructuredStorage::IPropertyBag, *},
            Variant::{VARIANT, VT_BSTR},
        },
    },
    core::Interface,
};
use windows_core::{ComObject, ComObjectInner, GUID, PWSTR, implement};

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
        _name: Option<&PWSTR>,
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

#[derive(Default)]
pub struct AMMediaType(AM_MEDIA_TYPE);

impl AMMediaType {
    pub fn new(typ: &AM_MEDIA_TYPE) -> Self {
        Self(unsafe { copy_media_type(typ) })
    }

    pub fn into_inner(mut self) -> AM_MEDIA_TYPE {
        let inner = std::mem::replace(&mut self.0, unsafe { std::mem::uninitialized() });
        std::mem::forget(self);
        inner
    }
}

impl Deref for AMMediaType {
    type Target = AM_MEDIA_TYPE;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Clone for AMMediaType {
    fn clone(&self) -> Self {
        Self(unsafe { copy_media_type(&self.0) })
    }
}

impl Drop for AMMediaType {
    fn drop(&mut self) {
        unsafe {
            if !self.0.pbFormat.is_null() {
                CoTaskMemFree(Some(self.0.pbFormat as *mut _));
                self.0.pbFormat = null_mut();
            }
        }
    }
}

#[implement(IBaseFilter, IMediaFilter)]
pub struct SinkFilter {
    state: RefCell<FILTER_STATE>,
    owning_graph: RefCell<Option<IFilterGraph>>,
    input_pin: ComObject<SinkInputPin>,
}

impl SinkFilter {
    pub fn new(callback: SinkCallback) -> ComObject<Self> {
        let this = SinkFilter {
            state: RefCell::new(State_Stopped),
            owning_graph: RefCell::new(None),
            input_pin: SinkInputPin {
                current_media_type: RefCell::new(Default::default()),
                connected_pin: RefCell::new(None),
                owner: RefCell::new(None),
                callback,
            }
            .into(),
        }
        .into_object();

        *this.input_pin.owner.borrow_mut() = Some(this.cast::<IBaseFilter>().unwrap());

        this
    }

    fn no_of_pins(&self) -> u32 {
        1
    }

    pub fn get_pin(&self, i: u32) -> Option<IPin> {
        if i == 0 {
            Some(unsafe { self.input_pin.get().cast() }.unwrap())
        } else {
            None
        }
    }
}

impl AsRef<SinkFilter> for SinkFilter {
    fn as_ref(&self) -> &Self {
        self
    }
}

impl IBaseFilter_Impl for SinkFilter_Impl {
    fn EnumPins(&self) -> windows_core::Result<windows::Win32::Media::DirectShow::IEnumPins> {
        Ok(PinEnumerator {
            filter: &self.this,
            index: Default::default(),
        }
        .into())
    }

    fn FindPin(
        &self,
        _id: &windows_core::PCWSTR,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::IPin> {
        Err(E_NOTIMPL.into())
    }

    fn QueryFilterInfo(
        &self,
        pinfo: *mut windows::Win32::Media::DirectShow::FILTER_INFO,
    ) -> windows_core::Result<()> {
        unsafe {
            (*pinfo).pGraph = ManuallyDrop::new(self.owning_graph.borrow().clone());
            (*pinfo).achName[0] = '\0' as u16;
        }
        Ok(())
    }

    fn JoinFilterGraph(
        &self,
        pgraph: windows_core::Ref<'_, windows::Win32::Media::DirectShow::IFilterGraph>,
        _pname: &windows_core::PCWSTR,
    ) -> windows_core::Result<()> {
        *self.owning_graph.borrow_mut() = pgraph.clone();

        Ok(())
    }

    fn QueryVendorInfo(&self) -> windows_core::Result<windows_core::PWSTR> {
        Ok(windows_core::PWSTR::null())
    }
}

impl IMediaFilter_Impl for SinkFilter_Impl {
    fn Stop(&self) -> windows_core::Result<()> {
        self.state.replace(State_Stopped);
        Ok(())
    }

    fn Pause(&self) -> windows_core::Result<()> {
        self.state.replace(State_Paused);
        Ok(())
    }

    fn Run(&self, _tstart: i64) -> windows_core::Result<()> {
        self.state.replace(State_Running);
        Ok(())
    }

    fn GetState(
        &self,
        _dwmillisecstimeout: u32,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::FILTER_STATE> {
        Ok(*self.state.borrow())
    }

    fn SetSyncSource(
        &self,
        _pclock: windows_core::Ref<'_, windows::Win32::Media::IReferenceClock>,
    ) -> windows_core::Result<()> {
        S_OK.ok()
    }

    fn GetSyncSource(&self) -> windows_core::Result<windows::Win32::Media::IReferenceClock> {
        Err(E_NOTIMPL.into())
    }
}

impl IPersist_Impl for SinkFilter_Impl {
    fn GetClassID(&self) -> windows_core::Result<windows_core::GUID> {
        unreachable!();
    }
}

#[implement(IEnumPins)]
struct PinEnumerator<'a> {
    filter: &'a dyn AsRef<SinkFilter>,
    index: RefCell<u32>,
}

impl<'a> IEnumPins_Impl for PinEnumerator_Impl<'a> {
    fn Next(
        &self,
        cpins: u32,
        pppins: windows_core::OutRef<'_, IPin>,
        pcfetched: *mut u32,
    ) -> windows_core::HRESULT {
        let mut pins_fetched = 0;

        let index = *self.index.borrow();
        let filter = self.filter.as_ref();
        if pins_fetched < cpins && filter.no_of_pins() > index {
            let pin = filter.get_pin(index);
            self.index.replace_with(|v| *v + 1);
            pins_fetched += 1;
            pppins.write(pin).unwrap();
        }

        if !pcfetched.is_null() {
            unsafe {
                *pcfetched = pins_fetched;
            }
        }

        if pins_fetched == cpins { S_OK } else { S_FALSE }
    }

    fn Skip(&self, cpins: u32) -> windows_core::Result<()> {
        let filter = self.filter.as_ref();
        if filter.no_of_pins() - *self.index.borrow() > cpins {
            self.index.replace_with(|v| *v + 1);
            return S_OK.ok();
        }

        self.index.replace(0);
        S_FALSE.ok()
    }

    fn Reset(&self) -> windows_core::Result<()> {
        self.index.replace(0);
        S_OK.ok()
    }

    fn Clone(&self) -> windows_core::Result<IEnumPins> {
        let result = unsafe { self.cast() };
        result
    }
}

pub type SinkCallback = Box<dyn Fn(&mut [u8], &AMMediaType, Option<Duration>)>;

#[implement(IPin, IMemInputPin)]
struct SinkInputPin {
    current_media_type: RefCell<AMMediaType>,
    connected_pin: RefCell<Option<IPin>>,
    owner: RefCell<Option<IBaseFilter>>,
    callback: SinkCallback,
}

impl SinkInputPin {
    unsafe fn get_valid_media_type(&self, index: i32, media_type: &mut AM_MEDIA_TYPE) -> bool {
        let video_info_header = &mut *(media_type.pbFormat as *mut KS_VIDEOINFOHEADER);

        video_info_header.bmiHeader.biSize = size_of::<KS_BITMAPINFOHEADER>() as u32;
        video_info_header.bmiHeader.biPlanes = 1;
        video_info_header.bmiHeader.biClrImportant = 0;
        video_info_header.bmiHeader.biClrUsed = 0;

        media_type.majortype = MEDIATYPE_Video;
        media_type.formattype = FORMAT_VideoInfo;
        media_type.bTemporalCompression = false.into();

        if index == 0 {
            video_info_header.bmiHeader.biCompression =
                u32::from_ne_bytes(*"yuy2".as_bytes().first_chunk::<4>().unwrap());
            video_info_header.bmiHeader.biBitCount = 16;
            video_info_header.bmiHeader.biWidth = 640;
            video_info_header.bmiHeader.biHeight = 480;
            media_type.subtype = MEDIASUBTYPE_YUY2;
            true
        } else {
            false
        }
    }
}

impl IPin_Impl for SinkInputPin_Impl {
    fn Connect(
        &self,
        preceivepin: windows_core::Ref<'_, IPin>,
        pmt: *const windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::Result<()> {
        let Some(preceivepin) = preceivepin.as_ref() else {
            return E_POINTER.ok();
        };

        if pmt.is_null() {
            return E_POINTER.ok();
        }

        self.connected_pin.replace(Some(preceivepin.clone()));
        unsafe { preceivepin.ReceiveConnection(&self.cast::<IPin>()?, pmt) }
    }

    fn ReceiveConnection(
        &self,
        pconnector: windows_core::Ref<'_, IPin>,
        pmt: *const windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::Result<()> {
        self.current_media_type
            .replace(AMMediaType::new(unsafe { &*pmt }));
        self.connected_pin.replace(pconnector.clone());
        S_OK.ok()
    }

    fn Disconnect(&self) -> windows_core::Result<()> {
        let result = match self.connected_pin.borrow_mut().take() {
            Some(_) => S_OK.ok(),
            None => VFW_E_NOT_CONNECTED.ok(),
        };
        result
    }

    fn ConnectedTo(&self) -> windows_core::Result<IPin> {
        let result = match self.connected_pin.borrow().as_ref() {
            Some(connected_pin) => Ok(connected_pin.clone()),
            None => Err(VFW_E_NOT_CONNECTED.into()),
        };
        result
    }

    fn ConnectionMediaType(
        &self,
        pmt: *mut windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::Result<()> {
        self.connected_pin
            .borrow()
            .as_ref()
            .ok_or(VFW_E_NOT_CONNECTED)?;

        unsafe { *pmt = self.current_media_type.borrow().clone().into_inner() };

        Ok(())
    }

    fn QueryPinInfo(
        &self,
        pinfo: *mut windows::Win32::Media::DirectShow::PIN_INFO,
    ) -> windows_core::Result<()> {
        unsafe {
            (*pinfo).dir = PINDIR_INPUT;
            (*pinfo).pFilter =
                ManuallyDrop::new(self.owner.borrow().as_ref().map(|v| (&*v).clone()));
            (*pinfo).achName[0] = '\0' as u16;
        }

        S_OK.ok()
    }

    fn QueryDirection(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::PIN_DIRECTION> {
        Ok(PINDIR_INPUT)
    }

    fn QueryId(&self) -> windows_core::Result<windows_core::PWSTR> {
        unreachable!()
    }

    fn QueryAccept(
        &self,
        _pmt: *const windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::HRESULT {
        S_FALSE
    }

    fn EnumMediaTypes(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::IEnumMediaTypes> {
        Ok(TypeEnumerator {
            index: Default::default(),
            pin: self,
        }
        .into())
    }

    fn QueryInternalConnections(
        &self,
        _appin: windows_core::OutRef<'_, IPin>,
        _npin: *mut u32,
    ) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EndOfStream(&self) -> windows_core::Result<()> {
        S_OK.ok()
    }

    fn BeginFlush(&self) -> windows_core::Result<()> {
        S_OK.ok()
    }

    fn EndFlush(&self) -> windows_core::Result<()> {
        S_OK.ok()
    }

    fn NewSegment(&self, _tstart: i64, _tstop: i64, _drate: f64) -> windows_core::Result<()> {
        unreachable!()
    }
}

impl IMemInputPin_Impl for SinkInputPin_Impl {
    fn GetAllocator(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::IMemAllocator> {
        Err(VFW_E_NO_ALLOCATOR.into())
    }

    fn NotifyAllocator(
        &self,
        _pallocator: windows_core::Ref<'_, windows::Win32::Media::DirectShow::IMemAllocator>,
        _breadonly: windows_core::BOOL,
    ) -> windows_core::Result<()> {
        S_OK.ok()
    }

    fn GetAllocatorRequirements(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::ALLOCATOR_PROPERTIES> {
        Err(E_NOTIMPL.into())
    }

    fn Receive(
        &self,
        psample: windows_core::Ref<'_, windows::Win32::Media::DirectShow::IMediaSample>,
    ) -> windows_core::Result<()> {
        let Some(psample) = psample.as_ref() else {
            return Ok(());
        };

        let mut ptimestart = 0;
        let mut ptimeend = 0;
        unsafe {
            psample.GetTime(&mut ptimestart, &mut ptimeend).unwrap();
        };

        let pts = ptimestart;
        let bytes = unsafe { psample.GetActualDataLength() };

        unsafe {
            if let Ok(new_media_type) = psample.GetMediaType() {
                if !new_media_type.is_null() {
                    self.current_media_type
                        .replace(AMMediaType::new(&*new_media_type));
                }
            }
        }

        let media_type = self.current_media_type.borrow();

        let format_str = unsafe { media_type.subtype_str() };

        let video_info =
            unsafe { &*(media_type.pbFormat as *const _ as *const KS_VIDEOINFOHEADER) };

        println!(
            "New frame: {}x{}, {pts}pts, {bytes} bytes, {}",
            video_info.bmiHeader.biWidth,
            video_info.bmiHeader.biHeight,
            format_str.unwrap_or("unknown format")
        );

        let length = unsafe { psample.GetActualDataLength() };

        if length <= 0 {
            return S_FALSE.ok();
        }

        let ptr = match unsafe { psample.GetPointer() } {
            Ok(ptr) => ptr,
            Err(_) => return S_FALSE.ok(),
        };

        let buffer = unsafe { std::slice::from_raw_parts_mut(ptr, length as usize) };

        let mut start_time = 0;
        let time_delta = unsafe { psample.GetTime(&mut start_time, &mut 0) }
            .ok()
            .map(|_| Duration::from_micros(start_time as u64 / 10));

        (self.callback)(buffer, &*media_type, time_delta);

        Ok(())
    }

    fn ReceiveMultiple(
        &self,
        psamples: *const Option<windows::Win32::Media::DirectShow::IMediaSample>,
        mut nsamples: i32,
    ) -> windows_core::Result<i32> {
        let mut processed: i32 = 0;
        while nsamples > 0 {
            unsafe { self.Receive((&*psamples.offset(processed as isize)).into())? };
            nsamples -= 1;
            processed += 1;
        }

        Ok(processed)
    }

    fn ReceiveCanBlock(&self) -> windows_core::Result<()> {
        S_FALSE.ok()
    }
}

#[implement(IEnumMediaTypes)]
struct TypeEnumerator<'a> {
    index: RefCell<i32>,
    pin: &'a SinkInputPin,
}

impl<'a> TypeEnumerator<'a> {
    unsafe fn free_allocated_media_types(allocated: usize, types: *mut *mut AM_MEDIA_TYPE) {
        for i in 0..allocated {
            CoTaskMemFree(Some((*(*types.add(i))).pbFormat as *const _));
            CoTaskMemFree(Some(*types.add(i) as *const _));
        }
    }
}

impl<'a> IEnumMediaTypes_Impl for TypeEnumerator_Impl<'a> {
    fn Next(
        &self,
        cmediatypes: u32,
        _ppmediatypes: *mut *mut AM_MEDIA_TYPE,
        pcfetched: *mut u32,
    ) -> windows_core::HRESULT {
        let mut types_fetched = 0;

        println!("next");

        while types_fetched < cmediatypes {
            unsafe {
                println!("loop");
                let typ = CoTaskMemAlloc(size_of::<AM_MEDIA_TYPE>()).cast::<AM_MEDIA_TYPE>();
                (*typ).cbFormat = size_of::<KS_VIDEOINFOHEADER>() as u32;
                if typ.is_null() {
                    return E_OUTOFMEMORY;
                }

                let format =
                    CoTaskMemAlloc(size_of::<KS_VIDEOINFOHEADER>()).cast::<KS_VIDEOINFOHEADER>();
                if format.is_null() {
                    CoTaskMemFree(Some(typ.cast_const().cast()));
                    return E_OUTOFMEMORY;
                }
                (*typ).pbFormat = format.cast::<u8>();

                if self
                    .pin
                    .get_valid_media_type(*self.index.borrow(), &mut *typ)
                {
                    *_ppmediatypes.add(types_fetched as usize) = typ;
                    self.index.replace_with(|v| (*v) + 1);
                    types_fetched += 1;
                } else {
                    CoTaskMemFree(Some(format.cast_const().cast()));
                    CoTaskMemFree(Some(typ.cast_const().cast()));
                    break;
                }
            }
        }

        if !pcfetched.is_null() {
            unsafe {
                *pcfetched = types_fetched;
            }
        }

        if types_fetched == cmediatypes {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Reset(&self) -> windows_core::Result<()> {
        self.index.replace(0);
        S_OK.ok()
    }

    fn Clone(&self) -> windows_core::Result<IEnumMediaTypes> {
        unsafe { self.cast() }
    }

    fn Skip(&self, _cmediatypes: u32) -> windows_core::Result<()> {
        self.index.replace_with(|v| (*v) + 1);
        S_OK.ok()
    }
}

unsafe fn copy_media_type(src: &AM_MEDIA_TYPE) -> AM_MEDIA_TYPE {
    let mut dest = src.clone();

    if src.cbFormat > 0 && !src.pbFormat.is_null() {
        let format_size = src.cbFormat as usize;
        let new_format = CoTaskMemAlloc(format_size) as *mut u8;

        if !new_format.is_null() {
            ptr::copy_nonoverlapping(src.pbFormat, new_format, format_size);
            dest.pbFormat = new_format;
        }
    }

    dest
}
