#![cfg(windows)]
#![allow(non_snake_case)]

use std::{
    cell::RefCell,
    ffi::{OsString, c_void},
    mem::{ManuallyDrop, MaybeUninit},
    ops::Deref,
    os::windows::ffi::OsStringExt,
    ptr::{self, null, null_mut},
    time::{Duration, Instant},
};
use tracing::*;
use windows::{
    Win32::{
        Foundation::*,
        Media::{
            DirectShow::*,
            KernelStreaming::{IKsPropertySet, KS_VIDEOINFOHEADER},
            MediaFoundation::*,
        },
        System::{
            Com::{StructuredStorage::IPropertyBag, *},
            Performance::QueryPerformanceCounter,
            Variant::{VARIANT, VT_BSTR},
        },
    },
    core::Interface,
};
use windows_core::{ComObject, ComObjectInner, GUID, PWSTR, implement};

pub fn initialize_directshow() -> windows_core::Result<()> {
    unsafe { CoInitialize(None) }.ok()
}

pub trait IPinExt {
    /// # Safety
    /// Do it correctly
    unsafe fn matches_category(&self, category: GUID) -> bool;

    /// # Safety
    /// Do it correctly
    unsafe fn matches_major_type(&self, major_type: GUID) -> bool;
}

impl IPinExt for IPin {
    unsafe fn matches_category(&self, category: GUID) -> bool {
        unsafe {
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

            return_value_size as usize == std::mem::size_of_val(&category)
                && pin_category == category
        }
    }
    unsafe fn matches_major_type(&self, major_type: GUID) -> bool {
        unsafe {
            let mut connection_media_type = AM_MEDIA_TYPE::default();
            self.ConnectionMediaType(&mut connection_media_type)
                .map(|_| connection_media_type.majortype == major_type)
                .unwrap_or(false)
        }
    }
}

pub trait IBaseFilterExt {
    fn get_pin(&self, direction: PIN_DIRECTION, category: GUID, major_type: GUID) -> Option<IPin>;

    /// # Safety
    /// Don't mess it up
    unsafe fn get_pin_by_name(
        &self,
        direction: PIN_DIRECTION,
        name: Option<&PWSTR>,
    ) -> windows_core::Result<Option<IPin>>;
}

impl IBaseFilterExt for IBaseFilter {
    fn get_pin(&self, direction: PIN_DIRECTION, category: GUID, major_type: GUID) -> Option<IPin> {
        unsafe {
            let pin_enum = self.EnumPins().ok()?;

            let _ = pin_enum.Reset();

            let mut pin = [None];
            while pin_enum.Next(&mut pin, None) == S_OK {
                let Some(pin) = pin[0].take() else {
                    break;
                };

                let Ok(pin_dir) = pin.QueryDirection() else {
                    continue;
                };

                if pin_dir == direction
                    && (category == GUID::zeroed() || pin.matches_category(category))
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
    ) -> windows_core::Result<Option<IPin>> {
        unsafe {
            let pin_enum = self.EnumPins()?;

            let _ = pin_enum.Reset();

            let mut pin = [None];
            while pin_enum.Next(&mut pin, None) == S_OK {
                let Some(pin) = pin[0].take() else {
                    break;
                };

                let pin_dir = pin.QueryDirection().unwrap();

                if pin_dir == direction {
                    return Ok(Some(pin));
                }
            }

            Ok(None)
        }
    }
}

pub trait VARIANTExt {
    fn to_os_string(&self) -> Option<OsString>;
}

impl VARIANTExt for VARIANT {
    fn to_os_string(&self) -> Option<OsString> {
        unsafe {
            (self.Anonymous.Anonymous.vt == VT_BSTR)
                .then(|| OsString::from_wide(self.Anonymous.Anonymous.Anonymous.bstrVal.deref()))
        }
    }
}

pub struct IAMStreamConfigMediaTypes<'a> {
    stream_config: &'a IAMStreamConfig,
    count: u32,
    caps: VIDEO_STREAM_CONFIG_CAPS,
    i: i32,
}

impl<'a> Iterator for IAMStreamConfigMediaTypes<'a> {
    type Item = (&'a AM_MEDIA_TYPEVideo, i32);

    fn next(&mut self) -> Option<Self::Item> {
        let i = self.i;

        if i >= self.count as i32 {
            return None;
        }

        self.i += 1;

        let mut media_type = null_mut();

        unsafe {
            self.stream_config
                .GetStreamCaps(i, &mut media_type, (&raw mut self.caps).cast::<u8>())
                .unwrap();

            if media_type.is_null() {
                return None;
            }

            Some((&*media_type, i))
        }
    }
}

impl<'a> IAMStreamConfigMediaTypes<'a> {
    pub fn count(&self) -> u32 {
        self.count
    }
}

pub trait IAMStreamConfigExt {
    fn media_types(&self) -> windows_core::Result<IAMStreamConfigMediaTypes<'_>>;
}

impl IAMStreamConfigExt for IAMStreamConfig {
    fn media_types(&self) -> windows_core::Result<IAMStreamConfigMediaTypes<'_>> {
        let mut count = 0;
        unsafe { self.GetNumberOfCapabilities(&mut count, &mut 0) }?;

        Ok(IAMStreamConfigMediaTypes {
            stream_config: self,
            count: count as u32,
            caps: VIDEO_STREAM_CONFIG_CAPS::default(),
            i: 0,
        })
    }
}

#[allow(non_camel_case_types)]
type AM_MEDIA_TYPEVideo = AM_MEDIA_TYPE;

#[allow(non_camel_case_types)]
pub trait AM_MEDIA_TYPEVideoExt {
    /// # Safety
    /// Just don't do it wrong
    unsafe fn video_info(&self) -> &KS_VIDEOINFOHEADER;
}

impl AM_MEDIA_TYPEVideoExt for AM_MEDIA_TYPEVideo {
    unsafe fn video_info(&self) -> &KS_VIDEOINFOHEADER {
        unsafe { &*self.pbFormat.cast::<KS_VIDEOINFOHEADER>() }
    }
}

#[allow(non_camel_case_types)]
pub trait AM_MEDIA_TYPEExt {
    /// # Safety
    /// Just don't do it wrong
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
            t if t == MEDIASUBTYPE_YV12 => "yv12",
            _ => return None,
        })
    }
}

pub trait IAMVideoControlExt {
    /// # Safety
    /// Just don't do it wrong
    unsafe fn time_per_frame_list<'a>(&self, pin: &'a IPin, i: i32, dimensions: SIZE) -> &'a [i64];
}

impl IAMVideoControlExt for IAMVideoControl {
    unsafe fn time_per_frame_list<'a>(&self, pin: &'a IPin, i: i32, dimensions: SIZE) -> &'a [i64] {
        unsafe {
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
}

pub trait IPropertyBagExt {
    /// # Safety
    /// Do it correctly
    unsafe fn read<P0>(&self, pszpropname: P0) -> windows_core::Result<VARIANT>
    where
        P0: windows_core::Param<windows_core::PCWSTR>;
}

impl IPropertyBagExt for IPropertyBag {
    /// # Safety
    /// Do it correctly
    unsafe fn read<P0>(&self, pszpropname: P0) -> windows_core::Result<VARIANT>
    where
        P0: windows_core::Param<windows_core::PCWSTR>,
    {
        unsafe {
            let mut ret = VARIANT::default();
            self.Read(pszpropname, &mut ret, None)?;
            Ok(ret)
        }
    }
}

pub struct VideoInputDeviceIterator {
    enum_moniker: Option<IEnumMoniker>,
    moniker: [Option<IMoniker>; 1],
}

impl VideoInputDeviceIterator {
    pub fn new() -> windows_core::Result<Self> {
        let enum_moniker = unsafe {
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

            // CreateClassEnumerator can return S_FALSE which is treated as success,
            // so we can't assume this exists
            enum_moniker
        };

        Ok(Self {
            enum_moniker,
            moniker: [None],
        })
    }
}

impl Iterator for VideoInputDeviceIterator {
    type Item = VideoInputDevice;

    fn next(&mut self) -> Option<Self::Item> {
        let Some(enum_moniker) = &mut self.enum_moniker else {
            return None;
        };

        while unsafe { enum_moniker.Next(&mut self.moniker, None) } == S_OK {
            if let Some(device) = self.moniker[0]
                .take()
                .and_then(|moniker| VideoInputDevice::new(moniker).ok())
            {
                return Some(device);
            }
        }

        None
    }
}

#[derive(Clone)]
pub struct VideoInputDevice {
    moniker: IMoniker,
    prop_bag: IPropertyBag,
    filter: IBaseFilter,
    output_pin: IPin,
    stream_config: IAMStreamConfig,
}

impl VideoInputDevice {
    fn new(moniker: IMoniker) -> windows_core::Result<Self> {
        let prop_bag: IPropertyBag = unsafe { moniker.BindToStorage(None, None) }?;
        let filter: IBaseFilter = unsafe { moniker.BindToObject(None, None) }?;

        let output_pin = filter
            .get_pin(PINDIR_OUTPUT, PIN_CATEGORY_CAPTURE, GUID::zeroed())
            .ok_or(E_FAIL)?;
        let stream_config = output_pin.cast::<IAMStreamConfig>().ok().ok_or(E_FAIL)?;

        Ok(Self {
            moniker,
            prop_bag,
            filter,
            output_pin,
            stream_config,
        })
    }

    pub fn name(&self) -> Option<OsString> {
        unsafe {
            self.prop_bag
                .read(windows_core::w!("Description"))
                .or_else(|_| self.prop_bag.read(windows_core::w!("FriendlyName")))
        }
        .ok()?
        .to_os_string()
    }

    pub fn id(&self) -> Option<OsString> {
        unsafe { self.prop_bag.read(windows_core::w!("DevicePath")) }
            .ok()
            .and_then(|v| v.to_os_string())
            .or_else(|| self.name())
    }

    pub fn model_id(&self) -> Option<String> {
        self.id()
            .and_then(|v| get_device_model_id(&v.to_string_lossy()))
    }

    pub fn media_types(&self) -> Option<VideoMediaTypesIterator<'_>> {
        self.stream_config
            .media_types()
            .map(|inner| VideoMediaTypesIterator { inner })
            .ok()
    }

    pub fn filter(&self) -> &IBaseFilter {
        &self.filter
    }

    pub fn stream_config(&self) -> &IAMStreamConfig {
        &self.stream_config
    }

    pub fn output_pin(&self) -> &IPin {
        &self.output_pin
    }

    pub fn start_capturing(
        self,
        format: &AMMediaType,
        callback: SinkCallback,
    ) -> Result<CaptureHandle, StartCapturingError> {
        unsafe {
            self.stream_config
                .SetFormat(&**format)
                .map_err(StartCapturingError::Other)?;

            let sink_filter = SinkFilter::new(format.clone(), callback);

            let input_sink_pin = sink_filter
                .get_pin(0)
                .ok_or(StartCapturingError::NoInputPin)?;

            let graph_builder: IGraphBuilder =
                CoCreateInstance(&CLSID_FilterGraph, None, CLSCTX_INPROC_SERVER)
                    .map_err(StartCapturingError::CreateGraph)?;

            let capture_graph_builder: ICaptureGraphBuilder2 =
                CoCreateInstance(&CLSID_CaptureGraphBuilder2, None, CLSCTX_INPROC_SERVER)
                    .map_err(StartCapturingError::CreateGraph)?;

            let media_control = graph_builder
                .cast::<IMediaControl>()
                .expect("Failed to cast IGraphBuilder to IMediaControl");

            capture_graph_builder
                .SetFiltergraph(&graph_builder)
                .map_err(StartCapturingError::ConfigureGraph)?;
            graph_builder
                .AddFilter(&self.filter, None)
                .map_err(StartCapturingError::ConfigureGraph)?;

            let sink_filter: IBaseFilter = sink_filter
                .cast()
                .expect("Failed to cast SinkFilter to IBaseFilter");

            graph_builder
                .AddFilter(&sink_filter, None)
                .map_err(StartCapturingError::ConfigureGraph)?;

            let mut stream_config = null_mut();
            capture_graph_builder
                .FindInterface(
                    Some(&PIN_CATEGORY_CAPTURE),
                    Some(&MEDIATYPE_Video),
                    &self.filter,
                    &IAMStreamConfig::IID,
                    &mut stream_config,
                )
                .map_err(StartCapturingError::ConfigureGraph)?;

            graph_builder
                .Connect(&self.output_pin, &input_sink_pin)
                .map_err(StartCapturingError::ConfigureGraph)?;

            media_control.Run().map_err(StartCapturingError::Run)?;

            Ok(CaptureHandle {
                media_control,
                graph_builder,
                output_capture_pin: self.output_pin,
                input_sink_pin,
            })
        }
    }
}

pub struct CaptureHandle {
    media_control: IMediaControl,
    graph_builder: IGraphBuilder,
    output_capture_pin: IPin,
    input_sink_pin: IPin,
}

impl CaptureHandle {
    // Chromium: VideoCaptureDeviceWin::StopAndDeallocate
    pub fn stop_capturing(self) -> windows_core::Result<()> {
        unsafe { self.media_control.Stop() }?;

        unsafe {
            let _ = self.graph_builder.Disconnect(&self.output_capture_pin);
            let _ = self.graph_builder.Disconnect(&self.input_sink_pin);
        }

        Ok(())
    }
}

#[derive(thiserror::Error, Debug)]
pub enum StartCapturingError {
    #[error("No input pin")]
    NoInputPin,
    #[error("CreateGraph: {0}")]
    CreateGraph(windows_core::Error),
    #[error("ConfigureGraph: {0}")]
    ConfigureGraph(windows_core::Error),
    #[error("Run: {0}")]
    Run(windows_core::Error),
    #[error("{0}")]
    Other(windows_core::Error),
}

impl Deref for VideoInputDevice {
    type Target = IMoniker;

    fn deref(&self) -> &Self::Target {
        &self.moniker
    }
}

pub struct VideoMediaTypesIterator<'a> {
    inner: IAMStreamConfigMediaTypes<'a>,
}

impl Iterator for VideoMediaTypesIterator<'_> {
    type Item = AMMediaType;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner
            .next()
            .map(|media_type| AMMediaType::new(media_type.0))
    }
}

#[derive(Default, Debug)]
pub struct AMMediaType(AM_MEDIA_TYPE);

impl AMMediaType {
    pub fn new(typ: &AM_MEDIA_TYPE) -> Self {
        Self(unsafe { copy_media_type(typ) })
    }

    pub fn into_inner(mut self) -> AM_MEDIA_TYPE {
        // SAFETY: Getting the inner value without triggering Drop
        let inner = std::mem::replace(&mut self.0, unsafe { MaybeUninit::uninit().assume_init() });
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
    pub fn new(desired_media_type: AMMediaType, callback: SinkCallback) -> ComObject<Self> {
        let this = SinkFilter {
            state: RefCell::new(State_Stopped),
            owning_graph: RefCell::new(None),
            input_pin: SinkInputPin {
                desired_media_type,
                callback: RefCell::new(callback),
                current_media_type: Default::default(),
                connected_pin: Default::default(),
                owner: Default::default(),
                first_ref_time: Default::default(),
            }
            .into(),
        }
        .into_object();

        // SAFETY: SinkFilter always implements IBaseFilter
        *this.input_pin.owner.borrow_mut() = Some(this.cast::<IBaseFilter>().unwrap());

        this
    }

    fn no_of_pins(&self) -> u32 {
        1
    }

    pub fn get_pin(&self, i: u32) -> Option<IPin> {
        if i == 0 {
            // SAFETY: SinkInputPin always implements IPin
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

    #[allow(clippy::not_unsafe_ptr_arg_deref)] // This is a public trait
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
        unsafe { self.cast() }
    }
}

pub struct CallbackData<'a> {
    pub sample: &'a IMediaSample,
    pub media_type: &'a AMMediaType,
    pub timestamp: Duration,
    pub perf_counter: i64,
}

pub type SinkCallback = Box<dyn FnMut(CallbackData)>;

#[implement(IPin, IMemInputPin)]
struct SinkInputPin {
    desired_media_type: AMMediaType,
    #[allow(unused)]
    current_media_type: RefCell<AMMediaType>,
    connected_pin: RefCell<Option<IPin>>,
    owner: RefCell<Option<IBaseFilter>>,
    callback: RefCell<SinkCallback>,
    first_ref_time: RefCell<Option<Instant>>,
}

// impl SinkInputPin {
//     unsafe fn get_valid_media_type(&self, index: i32, media_type: &mut AM_MEDIA_TYPE) -> bool {
//         unsafe {
//             let video_info_header = &mut *(media_type.pbFormat as *mut KS_VIDEOINFOHEADER);

//             video_info_header.bmiHeader.biSize = size_of::<KS_BITMAPINFOHEADER>() as u32;
//             video_info_header.bmiHeader.biPlanes = 1;
//             video_info_header.bmiHeader.biClrImportant = 0;
//             video_info_header.bmiHeader.biClrUsed = 0;

//             media_type.majortype = MEDIATYPE_Video;
//             media_type.formattype = FORMAT_VideoInfo;
//             media_type.bTemporalCompression = false.into();

//             if index == 0 {
//                 video_info_header.bmiHeader.biCompression =
//                     u32::from_ne_bytes(*"yuy2".as_bytes().first_chunk::<4>().unwrap());
//                 video_info_header.bmiHeader.biBitCount = 16;
//                 video_info_header.bmiHeader.biWidth = 640;
//                 video_info_header.bmiHeader.biHeight = 480;
//                 media_type.subtype = MEDIASUBTYPE_YUY2;
//                 true
//             } else {
//                 false
//             }
//         }
//     }
// }

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
        let mut connected_pin = self.connected_pin.borrow_mut();
        if pmt.is_null() {
            return E_POINTER.ok();
        }
        if connected_pin.is_some() {
            return VFW_E_ALREADY_CONNECTED.ok();
        }
        let Some(pconnector) = pconnector.as_ref() else {
            return E_POINTER.ok();
        };
        *connected_pin = Some(pconnector.clone());
        self.current_media_type
            .replace(AMMediaType::new(unsafe { &*pmt }));
        S_OK.ok()
    }

    fn Disconnect(&self) -> windows_core::Result<()> {
        match self.connected_pin.borrow_mut().take() {
            Some(_) => S_OK.ok(),
            None => VFW_E_NOT_CONNECTED.ok(),
        }
    }

    fn ConnectedTo(&self) -> windows_core::Result<IPin> {
        match self.connected_pin.borrow().as_ref() {
            Some(connected_pin) => Ok(connected_pin.clone()),
            None => Err(VFW_E_NOT_CONNECTED.into()),
        }
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
                ManuallyDrop::new(self.owner.borrow().as_ref().map(|v| (*v).clone()));
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
        let mut perf_counter = 0;
        unsafe { QueryPerformanceCounter(&mut perf_counter)? };

        let Some(psample) = psample.as_ref() else {
            return Ok(());
        };

        unsafe {
            if let Ok(new_media_type) = psample.GetMediaType()
                && !new_media_type.is_null()
            {
                self.current_media_type
                    .replace(AMMediaType::new(&*new_media_type));
            }
        }

        let media_type = self.current_media_type.borrow();

        let length = unsafe { psample.GetActualDataLength() };

        if length <= 0 {
            return S_FALSE.ok();
        }

        if unsafe { psample.GetPointer() }.is_err() {
            return S_FALSE.ok();
        }

        let mut start_time = 0;
        let mut end_time = 0;

        unsafe { psample.GetTime(&mut start_time, &mut end_time) }?;

        (self.callback.borrow_mut())(CallbackData {
            sample: psample,
            media_type: &media_type,
            timestamp: Duration::from_micros(start_time as u64 / 10),
            perf_counter,
        });

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

// impl<'a> TypeEnumerator<'a> {
//     unsafe fn free_allocated_media_types(allocated: usize, types: *mut *mut AM_MEDIA_TYPE) {
//         for i in 0..allocated {
//             unsafe {
//                 CoTaskMemFree(Some((*(*types.add(i))).pbFormat as *const _));
//                 CoTaskMemFree(Some(*types.add(i) as *const _));
//             }
//         }
//     }
// }

impl<'a> IEnumMediaTypes_Impl for TypeEnumerator_Impl<'a> {
    fn Next(
        &self,
        cmediatypes: u32,
        _ppmediatypes: *mut *mut AM_MEDIA_TYPE,
        pcfetched: *mut u32,
    ) -> windows_core::HRESULT {
        trace!("TypeEnumerator_Impl::Next");

        unsafe {
            let mut fetched = 0;

            if *self.index.borrow() == 0 && pcfetched.read() > 0 {
                let desired = &self.pin.desired_media_type.0;
                *_ppmediatypes = {
                    let typ = CoTaskMemAlloc(size_of::<AM_MEDIA_TYPE>()).cast::<AM_MEDIA_TYPE>();
                    *typ = desired.clone();
                    (*typ).cbFormat = size_of::<KS_VIDEOINFOHEADER>() as u32;
                    if typ.is_null() {
                        return E_OUTOFMEMORY;
                    }
                    let format = CoTaskMemAlloc(size_of::<KS_VIDEOINFOHEADER>())
                        .cast::<KS_VIDEOINFOHEADER>();
                    if format.is_null() {
                        CoTaskMemFree(Some(typ.cast_const().cast()));
                        return E_OUTOFMEMORY;
                    }
                    (*typ).pbFormat = format.cast::<u8>();
                    *format = *desired.pbFormat.cast::<KS_VIDEOINFOHEADER>();
                    typ
                };
                fetched = 1;
                self.index.replace_with(|v| *v + 1);
            }

            if !pcfetched.is_null() {
                *pcfetched = fetched;
            }

            if fetched == cmediatypes {
                S_OK
            } else {
                S_FALSE
            }
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
        let new_format = unsafe { CoTaskMemAlloc(format_size) as *mut u8 };

        if !new_format.is_null() {
            unsafe {
                ptr::copy_nonoverlapping(src.pbFormat, new_format, format_size);
            }
            dest.pbFormat = new_format;
        }
    }

    dest
}

fn get_device_model_id(device_id: &str) -> Option<String> {
    // const VID_PID_SIZE: usize = 4;

    let vid_location = device_id.find("vid_")?;
    let pid_location = device_id.find("pid_")?;

    if vid_location + "vid_".len() + 4 > device_id.len()
        || pid_location + "pid_".len() + 4 > device_id.len()
    {
        return None;
    }

    let id_vendor = &device_id[vid_location + 4..vid_location + 8];
    let id_product = &device_id[pid_location + 4..pid_location + 8];

    Some(format!("{id_vendor}:{id_product}"))
}
