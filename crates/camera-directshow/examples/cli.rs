use cap_camera_dshow::*;
use std::{
    cell::RefCell,
    fmt::Display,
    mem::ManuallyDrop,
    ops::Deref,
    ptr::{self, null_mut},
    time::Duration,
};
use tracing::{error, info, trace};
use windows::{
    Win32::{
        Foundation::{E_NOTIMPL, E_OUTOFMEMORY, E_POINTER, S_FALSE, S_OK, SIZE},
        Media::{
            DirectShow::{
                FILTER_STATE, IAMStreamConfig, IAMVideoControl, IBaseFilter, IBaseFilter_Impl,
                ICaptureGraphBuilder2, IEnumMediaTypes, IEnumMediaTypes_Impl, IEnumPins,
                IEnumPins_Impl, IFilterGraph, IGraphBuilder, IMediaControl, IMediaFilter,
                IMediaFilter_Impl, IMemInputPin, IMemInputPin_Impl, IPin, IPin_Impl, PINDIR_INPUT,
                PINDIR_OUTPUT, State_Paused, State_Running, State_Stopped, VFW_E_NO_ALLOCATOR,
                VFW_E_NOT_CONNECTED,
            },
            KernelStreaming::{KS_BITMAPINFOHEADER, KS_VIDEOINFOHEADER},
            MediaFoundation::{
                AM_MEDIA_TYPE, CLSID_CaptureGraphBuilder2, CLSID_FilterGraph, FORMAT_VideoInfo,
                MEDIASUBTYPE_YUY2, MEDIATYPE_Video, PIN_CATEGORY_CAPTURE,
            },
        },
        System::Com::{
            CLSCTX_INPROC_SERVER, CoCreateInstance, CoInitialize, CoTaskMemAlloc, CoTaskMemFree,
            IMoniker, IPersist_Impl, StructuredStorage::IPropertyBag,
        },
    },
    core::Interface,
};
use windows_core::{ComObject, ComObjectInner, GUID, implement};

fn main() {
    tracing_subscriber::fmt::init();

    unsafe {
        CoInitialize(None).unwrap();

        let devices = VideoInputDeviceEnumerator::new().unwrap().to_vec();

        let mut devices = devices
            .iter()
            .map(VideoDeviceSelectOption)
            .collect::<Vec<_>>();

        let selected = if devices.len() > 1 {
            inquire::Select::new("Select a device", devices)
                .prompt()
                .unwrap()
        } else {
            devices.remove(0)
        };

        let moniker = selected.0;

        let property_data: IPropertyBag = moniker.BindToStorage(None, None).unwrap();
        let device_name = property_data
            .read(windows_core::w!("FriendlyName"), None)
            .unwrap();

        let device_path = property_data
            .read(windows_core::w!("DevicePath"), None)
            .unwrap_or_default();

        let device_name = device_name.to_os_string().unwrap();
        println!("Info for device '{:?}'", device_name);

        let device_path = device_path.to_os_string();
        println!("Path: '{:?}'", device_path);

        let filter: IBaseFilter = moniker.BindToObject(None, None).unwrap();

        chromium_main(filter);

        return;
    }
}

#[derive(Debug)]
struct Format {
    width: i32,
    height: i32,
    media_type: AM_MEDIA_TYPE,
    frame_rates: Vec<f64>,
}

impl Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}x{} {} ({:?})",
            self.width,
            self.height,
            unsafe { self.media_type.subtype_str().unwrap_or("unknown") },
            &self.frame_rates
        )
    }
}

struct VideoDeviceSelectOption<'a>(&'a IMoniker);

impl<'a> Display for VideoDeviceSelectOption<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let device_name = unsafe {
            let property_data: IPropertyBag = self.0.BindToStorage(None, None).unwrap();

            let device_name = property_data
                .read(windows_core::w!("FriendlyName"), None)
                .unwrap();

            device_name.to_os_string().unwrap()
        };

        write!(f, "{:?}", device_name)
    }
}

// chromium

#[implement(IPin, IMemInputPin)]
struct SinkInputPin {
    current_media_type: RefCell<AMMediaType>,
    connected_pin: RefCell<Option<IPin>>,
    owner: RefCell<Option<*const IBaseFilter>>,
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
        trace!("Connect entry");
        let Some(preceivepin) = preceivepin.as_ref() else {
            trace!("Connect exit - E_POINTER");
            return E_POINTER.ok();
        };

        if pmt.is_null() {
            trace!("Connect exit - E_POINTER");
            return E_POINTER.ok();
        }
        let media_type = unsafe { &*pmt };

        dbg!(media_type);
        // self.current_media_type.replace(media_type.clone());
        self.connected_pin.replace(Some(preceivepin.clone()));
        let result = unsafe { preceivepin.ReceiveConnection(&self.cast::<IPin>()?, pmt) };
        trace!("Connect exit");
        result
    }

    fn ReceiveConnection(
        &self,
        pconnector: windows_core::Ref<'_, IPin>,
        pmt: *const windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::Result<()> {
        trace!("ReceiveConnection entry");
        self.current_media_type
            .replace(AMMediaType::new(unsafe { &*pmt }));
        self.connected_pin.replace(pconnector.clone());
        trace!("ReceiveConnection exit");
        S_OK.ok()
    }

    fn Disconnect(&self) -> windows_core::Result<()> {
        trace!("Disconnect entry");
        let result = match self.connected_pin.borrow_mut().take() {
            Some(_) => S_OK.ok(),
            None => VFW_E_NOT_CONNECTED.ok(),
        };
        trace!("Disconnect exit");
        result
    }

    fn ConnectedTo(&self) -> windows_core::Result<IPin> {
        trace!("ConnectedTo entry");
        let result = match self.connected_pin.borrow().as_ref() {
            Some(connected_pin) => Ok(connected_pin.clone()),
            None => Err(VFW_E_NOT_CONNECTED.into()),
        };
        trace!("ConnectedTo exit");
        result
    }

    fn ConnectionMediaType(
        &self,
        pmt: *mut windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::Result<()> {
        trace!("ConnectionMediaType entry");
        self.connected_pin
            .borrow()
            .as_ref()
            .ok_or(VFW_E_NOT_CONNECTED)?;

        unsafe { *pmt = self.current_media_type.borrow().clone().into_inner() };

        trace!("ConnectionMediaType exit");
        Ok(())
    }

    fn QueryPinInfo(
        &self,
        pinfo: *mut windows::Win32::Media::DirectShow::PIN_INFO,
    ) -> windows_core::Result<()> {
        trace!("QueryPinInfo before");
        unsafe {
            (*pinfo).dir = PINDIR_INPUT;
            (*pinfo).pFilter =
                ManuallyDrop::new(self.owner.borrow().as_ref().map(|v| (&**v).clone()));
            (*pinfo).achName[0] = '\0' as u16;
        }

        trace!("QueryPinInfo after");
        S_OK.ok()
    }

    fn QueryDirection(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::PIN_DIRECTION> {
        trace!("QueryDirection entry");
        trace!("QueryDirection exit");
        Ok(PINDIR_INPUT)
    }

    fn QueryId(&self) -> windows_core::Result<windows_core::PWSTR> {
        trace!("QueryId entry");
        unreachable!()
    }

    fn QueryAccept(
        &self,
        _pmt: *const windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE,
    ) -> windows_core::HRESULT {
        trace!("QueryAccept entry");
        trace!("QueryAccept exit");
        S_FALSE
    }

    fn EnumMediaTypes(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::IEnumMediaTypes> {
        trace!("EnumMediaTypes entry");
        Ok(TypeEnumerator {
            index: Default::default(),
            pin: self,
        }
        .into())
    }

    fn QueryInternalConnections(
        &self,
        appin: windows_core::OutRef<'_, IPin>,
        npin: *mut u32,
    ) -> windows_core::Result<()> {
        trace!("QueryInternalConnections entry");
        Err(E_NOTIMPL.into())
    }

    fn EndOfStream(&self) -> windows_core::Result<()> {
        trace!("EndOfStream entry");
        trace!("EndOfStream exit");
        S_OK.ok()
    }

    fn BeginFlush(&self) -> windows_core::Result<()> {
        trace!("BeginFlush entry");
        trace!("BeginFlush exit");
        S_OK.ok()
    }

    fn EndFlush(&self) -> windows_core::Result<()> {
        trace!("EndFlush entry");
        trace!("EndFlush exit");
        S_OK.ok()
    }

    fn NewSegment(&self, _tstart: i64, _tstop: i64, _drate: f64) -> windows_core::Result<()> {
        trace!("NewSegment entry");
        unreachable!()
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
        ppmediatypes: *mut *mut AM_MEDIA_TYPE,
        pcfetched: *mut u32,
    ) -> windows_core::HRESULT {
        trace!("TypeEnumerator::Next");
        dbg!(cmediatypes);
        dbg!(self.index.borrow());

        let mut types_fetched = 0;

        unsafe {
            while types_fetched < cmediatypes {
                let typ = CoTaskMemAlloc(size_of::<AM_MEDIA_TYPE>()) as *mut AM_MEDIA_TYPE;
                if typ.is_null() {
                    TypeEnumerator::free_allocated_media_types(
                        types_fetched as usize,
                        ppmediatypes,
                    );
                    return E_OUTOFMEMORY;
                }
                let typ = &mut *typ;

                *typ = AM_MEDIA_TYPE::default();
                typ.cbFormat = size_of::<KS_VIDEOINFOHEADER>() as u32;

                let format =
                    CoTaskMemAlloc(size_of::<KS_VIDEOINFOHEADER>()) as *mut KS_VIDEOINFOHEADER;
                if format.is_null() {
                    CoTaskMemFree(Some((typ as *const AM_MEDIA_TYPE).cast()));
                    TypeEnumerator::free_allocated_media_types(
                        types_fetched as usize,
                        ppmediatypes,
                    );
                    return E_OUTOFMEMORY;
                }
                typ.pbFormat = format as *mut _;

                if self.pin.get_valid_media_type(*self.index.borrow(), typ) {
                    self.index.replace_with(|v| *v + 1);

                    *ppmediatypes.add(types_fetched as usize) = typ;

                    types_fetched += 1;
                } else {
                    CoTaskMemFree(Some(format as *const _));
                    CoTaskMemFree(Some(typ as *mut _ as *const _));
                    break;
                }
            }

            if !pcfetched.is_null() {
                *pcfetched = types_fetched;
            }
        }

        if types_fetched == cmediatypes {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Skip(&self, cmediatypes: u32) -> windows_core::Result<()> {
        trace!("TypeEnumerator::Skip");
        self.index.replace_with(|v| (*v) + cmediatypes as i32);
        S_OK.ok()
    }

    fn Reset(&self) -> windows_core::Result<()> {
        trace!("TypeEnumerator::Reset");
        self.index.replace(0);
        S_OK.ok()
    }

    fn Clone(&self) -> windows_core::Result<IEnumMediaTypes> {
        trace!("TypeEnumerator::Clone");
        unsafe { self.cast() }
    }
}

impl IMemInputPin_Impl for SinkInputPin_Impl {
    fn GetAllocator(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::IMemAllocator> {
        trace!("GetAllocator entry");
        trace!("GetAllocator exit");
        Err(VFW_E_NO_ALLOCATOR.into())
    }

    fn NotifyAllocator(
        &self,
        _pallocator: windows_core::Ref<'_, windows::Win32::Media::DirectShow::IMemAllocator>,
        _breadonly: windows_core::BOOL,
    ) -> windows_core::Result<()> {
        trace!("NotifyAllocator entry");
        trace!("NotifyAllocator exit");
        S_OK.ok()
    }

    fn GetAllocatorRequirements(
        &self,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::ALLOCATOR_PROPERTIES> {
        trace!("GetAllocatorRequirements entry");
        trace!("GetAllocatorRequirements exit");
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

        Ok(())
    }

    fn ReceiveMultiple(
        &self,
        psamples: *const Option<windows::Win32::Media::DirectShow::IMediaSample>,
        mut nsamples: i32,
    ) -> windows_core::Result<i32> {
        trace!("ReceiveMultiple entry");
        let mut processed: i32 = 0;
        while nsamples > 0 {
            unsafe { self.Receive((&*psamples.offset(processed as isize)).into())? };
            nsamples -= 1;
            processed += 1;
        }

        trace!("ReceiveMultiple exit");
        Ok(processed)
    }

    fn ReceiveCanBlock(&self) -> windows_core::Result<()> {
        trace!("ReceiveCanBlock entry");
        trace!("ReceiveCanBlock exit");
        S_FALSE.ok()
    }
}

#[implement(IBaseFilter, IMediaFilter)]
struct SinkFilter {
    state: RefCell<FILTER_STATE>,
    owning_graph: RefCell<Option<IFilterGraph>>,
    input_pin: ComObject<SinkInputPin>,
}

impl SinkFilter {
    fn no_of_pins(&self) -> u32 {
        1
    }

    fn get_pin(&self, i: u32) -> Option<IPin> {
        if i == 0 {
            Some(unsafe { self.input_pin.get().cast() }.unwrap())
        } else {
            None
        }
    }
}

// impl Drop for SinkFilter {
//     fn drop(&mut self) {
//         self.input_pin.owner.borrow_mut().take();
//     }
// }

impl AsRef<SinkFilter> for SinkFilter {
    fn as_ref(&self) -> &Self {
        self
    }
}

impl IBaseFilter_Impl for SinkFilter_Impl {
    fn EnumPins(&self) -> windows_core::Result<windows::Win32::Media::DirectShow::IEnumPins> {
        trace!("FilterBase::EnumPins");
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
        trace!("FindPin entry");
        trace!("FindPin exit");
        Err(E_NOTIMPL.into())
    }

    fn QueryFilterInfo(
        &self,
        pinfo: *mut windows::Win32::Media::DirectShow::FILTER_INFO,
    ) -> windows_core::Result<()> {
        trace!("QueryFilterInfo entry");
        unsafe {
            (*pinfo).pGraph = ManuallyDrop::new(self.owning_graph.borrow().clone());
            (*pinfo).achName[0] = '\0' as u16;
        }
        trace!("QueryFilterInfo exit");
        Ok(())
    }

    fn JoinFilterGraph(
        &self,
        pgraph: windows_core::Ref<'_, windows::Win32::Media::DirectShow::IFilterGraph>,
        pname: &windows_core::PCWSTR,
    ) -> windows_core::Result<()> {
        trace!("JoinFilterGraph");
        *self.owning_graph.borrow_mut() = pgraph.clone();

        Ok(())
    }

    fn QueryVendorInfo(&self) -> windows_core::Result<windows_core::PWSTR> {
        trace!("QueryVendorInfo entry");
        trace!("QueryVendorInfo exit");
        Ok(windows_core::PWSTR::null())
    }
}

impl IMediaFilter_Impl for SinkFilter_Impl {
    fn Stop(&self) -> windows_core::Result<()> {
        trace!("Stop entry");
        self.state.replace(State_Stopped);
        trace!("Stop exit");
        Ok(())
    }

    fn Pause(&self) -> windows_core::Result<()> {
        trace!("Pause entry");
        self.state.replace(State_Paused);
        trace!("Pause exit");
        Ok(())
    }

    fn Run(&self, _tstart: i64) -> windows_core::Result<()> {
        trace!("Run entry");
        self.state.replace(State_Running);
        trace!("Run exit");
        Ok(())
    }

    fn GetState(
        &self,
        _dwmillisecstimeout: u32,
    ) -> windows_core::Result<windows::Win32::Media::DirectShow::FILTER_STATE> {
        trace!("GetState entry");
        trace!("GetState exit");
        Ok(*self.state.borrow())
    }

    fn SetSyncSource(
        &self,
        _pclock: windows_core::Ref<'_, windows::Win32::Media::IReferenceClock>,
    ) -> windows_core::Result<()> {
        trace!("SetSyncSource entry");
        trace!("SetSyncSource exit");
        S_OK.ok()
    }

    fn GetSyncSource(&self) -> windows_core::Result<windows::Win32::Media::IReferenceClock> {
        trace!("GetSyncSource entry");
        trace!("GetSyncSource exit");
        Err(E_NOTIMPL.into())
    }
}

impl IPersist_Impl for SinkFilter_Impl {
    fn GetClassID(&self) -> windows_core::Result<windows_core::GUID> {
        trace!("GetClassID");
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
        trace!("IEnumPins Next");
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
        trace!("Skip entry");
        let filter = self.filter.as_ref();
        if filter.no_of_pins() - *self.index.borrow() > cpins {
            self.index.replace_with(|v| *v + 1);
            trace!("Skip exit - S_OK");
            return S_OK.ok();
        }

        self.index.replace(0);
        trace!("Skip exit - S_FALSE");
        S_FALSE.ok()
    }

    fn Reset(&self) -> windows_core::Result<()> {
        trace!("Reset entry");
        self.index.replace(0);
        trace!("Reset exit");
        S_OK.ok()
    }

    fn Clone(&self) -> windows_core::Result<IEnumPins> {
        trace!("Clone entry");
        let result = unsafe { self.cast() };
        trace!("Clone exit");
        result
    }
}

unsafe fn chromium_main(capture_filter: IBaseFilter) {
    let output_capture_pin = capture_filter
        .get_pin(PINDIR_OUTPUT, PIN_CATEGORY_CAPTURE, GUID::zeroed())
        .unwrap();

    let stream_config = output_capture_pin.cast::<IAMStreamConfig>().unwrap();
    let video_control = output_capture_pin.cast::<IAMVideoControl>().ok();

    let mut media_types_iter = stream_config.media_types();

    // println!("Formats: {}", media_types_iter.count());

    let mut formats = Vec::with_capacity(media_types_iter.count() as usize);

    while let Some((media_type, i)) = media_types_iter.next() {
        let is_video =
            media_type.majortype == MEDIATYPE_Video && media_type.formattype == FORMAT_VideoInfo;

        if !is_video {
            continue;
        }

        // println!("Format {i}:");

        let video_info = &*media_type.video_info();

        let width = video_info.bmiHeader.biWidth;
        let height = video_info.bmiHeader.biHeight;

        // println!("  Dimensions: {width}x{height}");

        let subtype_str = media_type.subtype_str().unwrap_or("unknown subtype");

        // println!("  Pixel Format: {subtype_str}");

        let mut frame_rates = vec![];

        if let Some(video_control) = &video_control {
            let time_per_frame_list = video_control.time_per_frame_list(
                &output_capture_pin,
                i,
                SIZE {
                    cx: width,
                    cy: height,
                },
            );

            for time_per_frame in time_per_frame_list {
                if *time_per_frame <= 0 {
                    continue;
                }
                frame_rates.push(10_000_000.0 / *time_per_frame as f64)
            }
        }

        if frame_rates.is_empty() {
            let frame_rate = 10_000_000.0 / video_info.AvgTimePerFrame as f64;
            frame_rates.push(frame_rate);
        }

        frame_rates
            .iter_mut()
            .for_each(|v| *v = (*v * 100.0).round() / 100.0);

        // println!("  Frame Rates: {:?}", frame_rates);

        formats.push(Format {
            width,
            height,
            media_type: media_type.clone(),
            frame_rates,
        })
    }

    if formats.is_empty() {
        error!("No formats found");
        return;
    }

    let selected_format = inquire::Select::new("Select a format", formats)
        .prompt()
        .unwrap();

    stream_config
        .SetFormat(&selected_format.media_type)
        .unwrap();

    trace!("creating sink filter");
    let sink_filter = SinkFilter {
        state: RefCell::new(State_Stopped),
        owning_graph: RefCell::new(None),
        input_pin: SinkInputPin {
            current_media_type: RefCell::new(Default::default()),
            connected_pin: RefCell::new(None),
            owner: RefCell::new(None),
        }
        .into(),
    }
    .into_object();
    *sink_filter.input_pin.owner.borrow_mut() = Some(&sink_filter.cast::<IBaseFilter>().unwrap());
    trace!("created sink filter");

    let input_sink_pin = sink_filter.get_pin(0).unwrap();

    trace!("creating graph builder");
    let graph_builder: IGraphBuilder =
        CoCreateInstance(&CLSID_FilterGraph, None, CLSCTX_INPROC_SERVER).unwrap();
    trace!("created graph builder");
    trace!("creating capture graph builder");
    let capture_graph_builder: ICaptureGraphBuilder2 =
        CoCreateInstance(&CLSID_CaptureGraphBuilder2, None, CLSCTX_INPROC_SERVER).unwrap();
    trace!("created capture graph builder");
    trace!("creating media control");
    let media_control = graph_builder.cast::<IMediaControl>().unwrap();
    trace!("created media control");
    trace!("setting capture graph");
    capture_graph_builder
        .SetFiltergraph(&graph_builder)
        .unwrap();
    trace!("set capture graph");
    trace!("adding capture filter");
    graph_builder.AddFilter(&capture_filter, None).unwrap();
    trace!("added capture filter");
    trace!("creating sink filter");
    let sink_filter: IBaseFilter = sink_filter.cast().unwrap();
    trace!("adding sink filter");
    graph_builder.AddFilter(&sink_filter, None).unwrap();
    trace!("added sink filter");

    trace!("finding stream config");
    let mut stream_config = null_mut();
    capture_graph_builder
        .FindInterface(
            Some(&PIN_CATEGORY_CAPTURE),
            Some(&MEDIATYPE_Video),
            &capture_filter,
            &IAMStreamConfig::IID,
            &mut stream_config,
        )
        .unwrap();
    trace!("found stream config");

    graph_builder
        .ConnectDirect(&output_capture_pin, &input_sink_pin, None)
        .unwrap();

    media_control.Run().unwrap();

    std::thread::sleep(Duration::from_secs(10));
}

#[derive(Default)]
struct AMMediaType(AM_MEDIA_TYPE);

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
