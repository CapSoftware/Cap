use std::sync::{Arc, Mutex};
use windows::core::*;
use windows::Win32::Media::DirectShow::*;
use windows::Win32::System::Com::*;

// Custom capture filter that implements IBaseFilter
#[implement(IBaseFilter, IMediaFilter)]
pub struct CaptureFilter {
    ref_count: Arc<Mutex<u32>>,
    pins: Vec<ComPtr<CapturePin>>,
    graph: Option<IFilterGraph>,
    state: FILTER_STATE,
    callback: Arc<dyn Fn(bool, &[u8], i64, i64, i32) + Send + Sync>,
}

impl CaptureFilter {
    pub fn new(callback: Arc<dyn Fn(bool, &[u8], i64, i64, i32) + Send + Sync>) -> Self {
        let video_pin = CapturePin::new(
            MEDIATYPE_Video,
            Arc::clone(&callback),
            true, // is_video
        );

        let audio_pin = CapturePin::new(
            MEDIATYPE_Audio,
            Arc::clone(&callback),
            false, // is_video
        );

        Self {
            ref_count: Arc::new(Mutex::new(0)),
            pins: vec![video_pin, audio_pin],
            graph: None,
            state: FILTER_STATE::State_Stopped,
            callback,
        }
    }
}

impl IBaseFilter_Impl for CaptureFilter {
    fn EnumPins(&self, ppenum: *mut Option<IEnumPins>) -> Result<()> {
        // Create pin enumerator
        let enumerator = PinEnumerator::new(self.pins.clone());
        unsafe {
            *ppenum = Some(enumerator.into());
        }
        Ok(())
    }

    fn FindPin(&self, id: &PCWSTR, pppin: *mut Option<IPin>) -> Result<()> {
        let pin_id = unsafe { id.to_string() }.map_err(|_| E_INVALIDARG)?;

        for pin in &self.pins {
            let pin_info = pin.get_info();
            if pin_info.name == pin_id {
                pin.AddRef();
                unsafe {
                    *pppin = Some(pin.cast()?);
                }
                return Ok(());
            }
        }

        Err(VFW_E_NOT_FOUND.into())
    }

    fn GetState(&self, dwmillisecstimeout: u32, state: *mut FILTER_STATE) -> Result<()> {
        unsafe {
            *state = self.state;
        }
        Ok(())
    }

    fn SetSyncSource(&self, pclock: Option<&IReferenceClock>) -> Result<()> {
        // Store reference clock if needed
        Ok(())
    }

    fn GetSyncSource(&self, ppclock: *mut Option<IReferenceClock>) -> Result<()> {
        unsafe {
            *ppclock = None;
        }
        Ok(())
    }

    fn JoinFilterGraph(&self, pgraph: Option<&IFilterGraph>, pname: &PCWSTR) -> Result<()> {
        // Store graph reference
        Ok(())
    }

    fn QueryFilterInfo(&self, pinfo: *mut FILTER_INFO) -> Result<()> {
        unsafe {
            (*pinfo).achName = [0; 128];
            let name = "Capture Filter\0".encode_utf16().collect::<Vec<_>>();
            (*pinfo).achName[..name.len()].copy_from_slice(&name);
            (*pinfo).pGraph = self.graph.as_ref().map(|g| {
                g.AddRef();
                g.as_raw()
            });
        }
        Ok(())
    }

    fn Stop(&self) -> Result<()> {
        self.state = FILTER_STATE::State_Stopped;
        Ok(())
    }

    fn Pause(&self) -> Result<()> {
        self.state = FILTER_STATE::State_Paused;
        Ok(())
    }

    fn Run(&self, tstart: i64) -> Result<()> {
        self.state = FILTER_STATE::State_Running;
        Ok(())
    }

    fn GetClassID(&self, pclsid: *mut GUID) -> Result<()> {
        unsafe {
            *pclsid = GUID::new();
        }
        Ok(())
    }
}

// Custom pin that receives media samples
#[implement(IPin, IMemInputPin)]
pub struct CapturePin {
    ref_count: Arc<Mutex<u32>>,
    media_type: GUID,
    callback: Arc<dyn Fn(bool, &[u8], i64, i64, i32) + Send + Sync>,
    is_video: bool,
    connected_pin: Option<IPin>,
    allocator: Option<IMemAllocator>,
}

impl CapturePin {
    fn new(
        media_type: GUID,
        callback: Arc<dyn Fn(bool, &[u8], i64, i64, i32) + Send + Sync>,
        is_video: bool,
    ) -> ComPtr<Self> {
        Self {
            ref_count: Arc::new(Mutex::new(0)),
            media_type,
            callback,
            is_video,
            connected_pin: None,
            allocator: None,
        }
        .into()
    }
}

impl IMemInputPin_Impl for CapturePin {
    fn Receive(&self, psample: Option<&IMediaSample>) -> Result<()> {
        if let Some(sample) = psample {
            // This is where we receive the actual media data!
            let buffer = unsafe {
                let mut buffer_ptr = std::ptr::null_mut();
                let buffer_size = sample.GetPointer(&mut buffer_ptr)?;
                std::slice::from_raw_parts(buffer_ptr, buffer_size as usize)
            };

            // Get timing information
            let mut start_time = 0i64;
            let mut stop_time = 0i64;
            let has_time = unsafe { sample.GetTime(&mut start_time, &mut stop_time).is_ok() };

            if has_time {
                // Call the callback with the received data
                (self.callback)(self.is_video, buffer, start_time, stop_time, 0);
            }
        }

        Ok(())
    }

    fn ReceiveMultiple(
        &self,
        ppsamples: *const Option<IMediaSample>,
        nsamples: i32,
        nprocesesed: *mut i32,
    ) -> Result<()> {
        // Process multiple samples
        for i in 0..nsamples {
            unsafe {
                let sample = *ppsamples.offset(i as isize);
                self.Receive(sample.as_ref())?;
            }
        }

        unsafe {
            *nprocesesed = nsamples;
        }

        Ok(())
    }

    fn ReceiveCanBlock(&self) -> Result<()> {
        Ok(())
    }

    fn GetAllocator(&self, ppallocator: *mut Option<IMemAllocator>) -> Result<()> {
        if let Some(allocator) = &self.allocator {
            allocator.AddRef();
            unsafe {
                *ppallocator = Some(allocator.clone());
            }
        } else {
            unsafe {
                *ppallocator = None;
            }
        }
        Ok(())
    }

    fn NotifyAllocator(&self, pallocator: Option<&IMemAllocator>, breadonly: BOOL) -> Result<()> {
        self.allocator = pallocator.map(|a| a.clone());
        Ok(())
    }

    fn GetAllocatorRequirements(&self, pprops: *mut ALLOCATOR_PROPERTIES) -> Result<()> {
        unsafe {
            (*pprops).cBuffers = 1;
            (*pprops).cbBuffer = 1024 * 1024; // 1MB buffer
            (*pprops).cbAlign = 1;
            (*pprops).cbPrefix = 0;
        }
        Ok(())
    }
}
