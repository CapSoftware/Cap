#![cfg(windows)]
#![allow(non_snake_case)]

use std::{
    ffi::OsString,
    fmt::Display,
    mem::MaybeUninit,
    ops::{Deref, DerefMut},
    os::windows::ffi::OsStringExt,
    ptr::null_mut,
    slice::from_raw_parts,
    sync::{
        Mutex,
        mpsc::{Receiver, Sender, channel},
    },
    time::{Duration, Instant},
};

use tracing::error;
use windows::Win32::{
    Foundation::{S_FALSE, *},
    Media::MediaFoundation::*,
    System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoInitialize},
};
use windows_core::{ComObjectInner, Interface, PWSTR, implement};

pub fn initialize_mediafoundation() -> windows_core::Result<()> {
    unsafe { CoInitialize(None) }.ok()?;
    unsafe { MFStartup(MF_API_VERSION, MFSTARTUP_NOSOCKET) }
}

pub struct DeviceSourcesIterator {
    _attributes: IMFAttributes,
    count: u32,
    devices: *mut Option<IMFActivate>,
    index: u32,
}

impl DeviceSourcesIterator {
    pub fn new() -> Result<Self, windows_core::Error> {
        let mut attributes = None;
        unsafe { MFCreateAttributes(&mut attributes, 1)? };
        let attributes = attributes.unwrap();

        unsafe {
            attributes.SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )?;
        }

        let mut count = 0;
        let mut devices = MaybeUninit::uninit();

        unsafe {
            MFEnumDeviceSources(&attributes, devices.as_mut_ptr(), &mut count)?;
        }

        Ok(DeviceSourcesIterator {
            _attributes: attributes,
            devices: unsafe { devices.assume_init() },
            count,
            index: 0,
        })
    }

    pub fn len(&self) -> u32 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
}

impl Iterator for DeviceSourcesIterator {
    type Item = Device;

    fn next(&mut self) -> Option<Self::Item> {
        if self.count == 0 {
            return None;
        }

        loop {
            let index = self.index;
            if index >= self.count {
                return None;
            }

            self.index += 1;

            let Some(device) = (unsafe { &(*self.devices.add(index as usize)) }) else {
                continue;
            };

            let media_source = match unsafe { device.ActivateObject::<IMFMediaSource>() } {
                Ok(v) => v,
                Err(e) => {
                    error!("Failed to activate IMFMediaSource: {}", e);
                    return None;
                }
            };

            return Some(Device {
                media_source,
                activate: device.clone(),
            });
        }
    }
}

#[derive(Clone)]
pub struct Device {
    activate: IMFActivate,
    pub media_source: IMFMediaSource,
}

#[derive(thiserror::Error, Debug)]
pub enum StartCapturingError {
    #[error("CreateEngine: {0}")]
    CreateEngine(windows_core::Error),
    #[error("ConfigureEngine: {0}")]
    ConfigureEngine(windows_core::Error),
    #[error("InitializeEngine: {0}")]
    InitializeEngine(windows_core::Error),
    #[error("ConfigureSource: {0}")]
    ConfigureSource(windows_core::Error),
    #[error("ConfigureSink: {0}")]
    ConfigureSink(windows_core::Error),
    #[error("StartPreview: {0}")]
    StartPreview(windows_core::Error),
}

impl Device {
    pub fn name(&self) -> windows_core::Result<OsString> {
        let mut raw = PWSTR(&mut 0);
        let mut length = 0;
        unsafe {
            self.activate
                .GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut raw, &mut length)
                .map(|_| OsString::from_wide(from_raw_parts(raw.0, length as usize)))
        }
    }

    pub fn id(&self) -> windows_core::Result<OsString> {
        let mut raw = PWSTR(&mut 0);
        let mut length = 0;
        unsafe {
            self.activate
                .GetAllocatedString(
                    &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                    &mut raw,
                    &mut length,
                )
                .map(|_| OsString::from_wide(from_raw_parts(raw.0, length as usize)))
        }
    }

    pub fn model_id(&self) -> Option<String> {
        self.id()
            .ok()
            .and_then(|v| get_device_model_id(&v.to_string_lossy()))
    }

    // Returns an iterator of IMFMediaTypes available for this device.
    // Creates and disposes an IMFSourceReader internally,
    // so this device must be shut down manually after calling this function.
    pub fn formats(&self) -> windows_core::Result<impl Iterator<Item = IMFMediaType>> {
        let mut stream_index = 0;

        let reader = unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1)?;
            let attributes =
                attributes.ok_or_else(|| windows_core::Error::from_hresult(S_FALSE))?;
            // Media source shuts down on drop if this isn't specified
            attributes.SetUINT32(&MF_SOURCE_READER_DISCONNECT_MEDIASOURCE_ON_SHUTDOWN, 1)?;
            MFCreateSourceReaderFromMediaSource(&self.media_source, &attributes)
                .map(|inner| SourceReader { inner })
        }?;

        Ok(std::iter::from_fn(move || {
            let media_type = unsafe {
                reader
                    .GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, stream_index)
            }
            .ok()?;

            stream_index += 1;

            Some(media_type)
        }))
    }

    pub fn start_capturing(
        &self,
        requested_format: &IMFMediaType,
        callback: Box<dyn FnMut(CallbackData) + 'static>,
    ) -> Result<CaptureHandle, StartCapturingError> {
        unsafe {
            let capture_engine_factory: IMFCaptureEngineClassFactory = CoCreateInstance(
                &CLSID_MFCaptureEngineClassFactory,
                None,
                CLSCTX_INPROC_SERVER,
            )
            .map_err(StartCapturingError::CreateEngine)?;

            let engine: IMFCaptureEngine = capture_engine_factory
                .CreateInstance(&CLSID_MFCaptureEngine)
                .map_err(StartCapturingError::CreateEngine)?;

            let (event_tx, event_rx) = channel();
            let video_callback = VideoCallback {
                event_tx,
                sample_callback: Mutex::new(callback),
            }
            .into_object();

            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1).map_err(StartCapturingError::ConfigureEngine)?;
            let attributes = attributes.ok_or_else(|| {
                StartCapturingError::ConfigureEngine(windows_core::Error::from_hresult(S_FALSE))
            })?;
            attributes
                .SetUINT32(&MF_CAPTURE_ENGINE_USE_VIDEO_DEVICE_ONLY, 1)
                .map_err(StartCapturingError::ConfigureEngine)?;

            println!("Initializing engine...");

            engine
                .Initialize(
                    &video_callback.to_interface::<IMFCaptureEngineOnEventCallback>(),
                    &attributes,
                    None,
                    &self.media_source,
                )
                .map_err(StartCapturingError::InitializeEngine)?;

            let Ok(_) = wait_for_event(&event_rx, CaptureEngineEventVariant::Initialized) else {
                return Err(StartCapturingError::InitializeEngine(
                    windows_core::Error::from_hresult(S_FALSE),
                ));
            };

            println!("Engine initialized.");

            let source = engine
                .GetSource()
                .map_err(StartCapturingError::ConfigureSource)?;

            let stream_count = retry_on_invalid_request(|| source.GetDeviceStreamCount())
                .map_err(StartCapturingError::ConfigureSource)?;

            let mut maybe_format = None;

            for stream_index in 0..stream_count {
                let Ok(category) =
                    retry_on_invalid_request(|| source.GetDeviceStreamCategory(stream_index))
                else {
                    continue;
                };

                if category != MF_CAPTURE_ENGINE_STREAM_CATEGORY_VIDEO_CAPTURE
                    && category != MF_CAPTURE_ENGINE_STREAM_CATEGORY_VIDEO_PREVIEW
                {
                    continue;
                }

                let mut media_type_index = 0;

                loop {
                    let mut media_type = None;
                    if retry_on_invalid_request(|| {
                        source.GetAvailableDeviceMediaType(
                            stream_index,
                            media_type_index,
                            Some(&mut media_type),
                        )
                    })
                    .is_err()
                    {
                        break;
                    }

                    let Some(media_type) = media_type else {
                        continue;
                    };

                    media_type_index += 1;

                    if media_type.IsEqual(requested_format) == Ok(0b1111) {
                        maybe_format = Some((media_type, stream_index));
                    }
                }
            }

            let Some((format, stream_index)) = maybe_format else {
                return Err(StartCapturingError::ConfigureSource(
                    MF_E_INVALIDREQUEST.into(),
                ));
            };

            source
                .SetCurrentDeviceMediaType(stream_index, &format)
                .map_err(StartCapturingError::ConfigureSource)?;

            let sink = engine
                .GetSink(MF_CAPTURE_ENGINE_SINK_TYPE_PREVIEW)
                .map_err(StartCapturingError::ConfigureSink)?;
            let preview_sink: IMFCapturePreviewSink =
                sink.cast().map_err(StartCapturingError::ConfigureSink)?;
            preview_sink
                .RemoveAllStreams()
                .map_err(StartCapturingError::ConfigureSink)?;

            let mut preview_stream_index = 0;
            preview_sink
                .AddStream(
                    stream_index,
                    Some(&format),
                    None,
                    Some(&mut preview_stream_index),
                )
                .map_err(StartCapturingError::ConfigureSink)?;
            preview_sink
                .SetSampleCallback(preview_stream_index, Some(&video_callback.into_interface()))
                .map_err(StartCapturingError::ConfigureSink)?;

            engine
                .StartPreview()
                .map_err(StartCapturingError::StartPreview)?;

            wait_for_event(&event_rx, CaptureEngineEventVariant::PreviewStarted)
                .map_err(|v| StartCapturingError::StartPreview(v.into()))?;

            Ok(CaptureHandle { engine, event_rx })
        }
    }
}

fn retry_on_invalid_request<T>(
    mut cb: impl FnMut() -> windows_core::Result<T>,
) -> windows_core::Result<T> {
    let mut retry_count = 0;

    const MAX_RETRIES: u32 = 100;
    const RETRY_DELAY: Duration = Duration::from_millis(50);

    loop {
        match cb() {
            Ok(result) => return Ok(result),
            Err(e) if e.code() == MF_E_INVALIDREQUEST => {
                if retry_count >= MAX_RETRIES {
                    return Err(e);
                }
                retry_count += 1;
                std::thread::sleep(RETRY_DELAY);
            }
            Err(e) => return Err(e),
        }
    }
}

pub struct CaptureHandle {
    event_rx: Receiver<CaptureEngineEvent>,
    engine: IMFCaptureEngine,
}

impl CaptureHandle {
    pub fn event_rx(&self) -> &Receiver<CaptureEngineEvent> {
        &self.event_rx
    }

    pub fn stop_capturing(self) -> windows_core::Result<()> {
        unsafe { self.engine.StopPreview() }
    }
}

impl Deref for Device {
    type Target = IMFMediaSource;

    fn deref(&self) -> &Self::Target {
        &self.media_source
    }
}

impl DerefMut for Device {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.media_source
    }
}

impl Display for Device {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            self.name()
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or_else(|_| "Unknown device name".to_string())
        )
    }
}

#[derive(Clone)]
pub struct SourceReader {
    inner: IMFSourceReader,
}

impl SourceReader {
    pub fn native_media_types(
        &self,
        stream_index: u32,
    ) -> windows_core::Result<NativeMediaTypesIterator<'_>> {
        NativeMediaTypesIterator::new(&self.inner, stream_index)
    }

    pub fn set_current_media_type(
        &self,
        stream_index: u32,
        media_type: &IMFMediaType,
    ) -> windows_core::Result<()> {
        unsafe {
            self.inner
                .SetCurrentMediaType(stream_index, None, media_type)
        }
    }

    pub fn try_read_sample(&self, stream_index: u32) -> windows_core::Result<Option<VideoSample>> {
        let mut imf_sample = None;
        let mut stream_flags = 0;

        let imf_sample = loop {
            unsafe {
                self.ReadSample(
                    stream_index,
                    0,
                    None,
                    Some(&mut stream_flags),
                    None,
                    Some(&mut imf_sample),
                )?;
            }

            if let Some(imf_sample) = imf_sample {
                break imf_sample;
            }
        };

        if stream_flags as i32 & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
            == MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
        {
            return Ok(None);
            // selected_format =
            //     VideoFormat::new(reader.GetCurrentMediaType(stream_index).unwrap())
            //         .unwrap();
        }

        Ok(Some(VideoSample(imf_sample)))
    }
}

pub struct VideoSample(IMFSample);

impl VideoSample {
    pub fn bytes(&self) -> windows_core::Result<Vec<u8>> {
        unsafe {
            let bytes = self.0.GetTotalLength()?;
            let mut out = Vec::with_capacity(bytes as usize);

            let buffer_count = self.0.GetBufferCount()?;
            for buffer_i in 0..buffer_count {
                let buffer = self.0.GetBufferByIndex(buffer_i)?;

                let bytes = buffer.lock()?;
                out.extend(&*bytes);
            }

            Ok(out)
        }
    }
}

pub struct NativeMediaTypesIterator<'a> {
    reader: &'a IMFSourceReader,
    i: u32,
    stream_index: u32,
}

impl<'a> NativeMediaTypesIterator<'a> {
    fn new(reader: &'a IMFSourceReader, stream_index: u32) -> windows_core::Result<Self> {
        unsafe { reader.GetNativeMediaType(stream_index, 0) }?;

        Ok(Self {
            reader,
            i: 0,
            stream_index,
        })
    }
}

impl Iterator for NativeMediaTypesIterator<'_> {
    type Item = IMFMediaType;

    fn next(&mut self) -> Option<Self::Item> {
        let ret = unsafe { self.reader.GetNativeMediaType(self.stream_index, self.i) }.ok()?;
        self.i += 1;
        Some(ret)
    }
}

impl Deref for SourceReader {
    type Target = IMFSourceReader;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl DerefMut for SourceReader {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
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

pub trait IMFMediaBufferExt {
    fn lock(&self) -> windows_core::Result<IMFMediaBufferLock<'_>>;
}

impl IMFMediaBufferExt for IMFMediaBuffer {
    fn lock(&self) -> windows_core::Result<IMFMediaBufferLock<'_>> {
        let mut bytes_ptr = null_mut();
        let mut size = 0;

        unsafe {
            self.Lock(&mut bytes_ptr, None, Some(&mut size))?;
        }

        Ok(IMFMediaBufferLock {
            source: self,
            bytes: unsafe { std::slice::from_raw_parts_mut(bytes_ptr, size as usize) },
        })
    }
}

pub struct IMFMediaBufferLock<'a> {
    source: &'a IMFMediaBuffer,
    bytes: &'a mut [u8],
}

impl<'a> Drop for IMFMediaBufferLock<'a> {
    fn drop(&mut self) {
        let _ = unsafe { self.source.Unlock() };
    }
}

impl<'a> Deref for IMFMediaBufferLock<'a> {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.bytes
    }
}

impl<'a> DerefMut for IMFMediaBufferLock<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.bytes
    }
}

pub struct CallbackData {
    pub sample: IMFSample,
    pub reference_time: Instant,
    pub timestamp: Duration,
    pub capture_begin_time: Instant,
}

#[implement(IMFCaptureEngineOnSampleCallback, IMFCaptureEngineOnEventCallback)]
struct VideoCallback {
    event_tx: Sender<CaptureEngineEvent>,
    sample_callback: Mutex<Box<dyn FnMut(CallbackData)>>,
}

impl IMFCaptureEngineOnSampleCallback_Impl for VideoCallback_Impl {
    fn OnSample(&self, psample: windows_core::Ref<'_, IMFSample>) -> windows_core::Result<()> {
        let Some(sample) = psample.as_ref() else {
            return Ok(());
        };

        let Ok(mut callback) = self.sample_callback.lock() else {
            return Ok(());
        };

        let reference_time = Instant::now();
        let mf_time_now = Duration::from_micros(unsafe { MFGetSystemTime() / 10 } as u64);

        let raw_time_stamp = unsafe { sample.GetSampleTime() }.unwrap_or(0);
        let timestamp = Duration::from_micros((raw_time_stamp / 10) as u64);

        let raw_capture_begin_time =
            unsafe { sample.GetUINT64(&MFSampleExtension_DeviceReferenceSystemTime) }
                .or_else(
                    // retry, it's what chromium does /shrug
                    |_| unsafe { sample.GetUINT64(&MFSampleExtension_DeviceReferenceSystemTime) },
                )
                .unwrap_or(unsafe { MFGetSystemTime() } as u64);

        let capture_begin_time =
            reference_time + Duration::from_micros(raw_capture_begin_time / 10) - mf_time_now;

        (callback)(CallbackData {
            sample: sample.clone(),
            reference_time,
            timestamp,
            capture_begin_time,
        });

        Ok(())
    }
}

impl IMFCaptureEngineOnEventCallback_Impl for VideoCallback_Impl {
    fn OnEvent(&self, pevent: windows_core::Ref<'_, IMFMediaEvent>) -> windows_core::Result<()> {
        let Some(event) = pevent.as_ref() else {
            return S_OK.ok();
        };

        let _ = self.event_tx.send(CaptureEngineEvent(event.clone()));

        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct CaptureEngineEvent(IMFMediaEvent);

impl CaptureEngineEvent {
    pub fn variant(&self) -> Option<CaptureEngineEventVariant> {
        Some(match unsafe { self.0.GetExtendedType() }.ok()? {
            MF_CAPTURE_ENGINE_ALL_EFFECTS_REMOVED => CaptureEngineEventVariant::AllEffectsRemoved,
            MF_CAPTURE_ENGINE_CAMERA_STREAM_BLOCKED => {
                CaptureEngineEventVariant::CameraStreamBlocked
            }
            MF_CAPTURE_ENGINE_CAMERA_STREAM_UNBLOCKED => {
                CaptureEngineEventVariant::CameraStreamUnblocked
            }
            MF_CAPTURE_ENGINE_EFFECT_ADDED => CaptureEngineEventVariant::EffectAdded,
            MF_CAPTURE_ENGINE_EFFECT_REMOVED => CaptureEngineEventVariant::EffectRemoved,
            MF_CAPTURE_ENGINE_ERROR => CaptureEngineEventVariant::Error,
            MF_CAPTURE_ENGINE_INITIALIZED => CaptureEngineEventVariant::Initialized,
            MF_CAPTURE_ENGINE_PHOTO_TAKEN => CaptureEngineEventVariant::PhotoTaken,
            MF_CAPTURE_ENGINE_PREVIEW_STARTED => CaptureEngineEventVariant::PreviewStarted,
            MF_CAPTURE_ENGINE_PREVIEW_STOPPED => CaptureEngineEventVariant::PreviewStopped,
            MF_CAPTURE_ENGINE_RECORD_STARTED => CaptureEngineEventVariant::RecordStarted,
            MF_CAPTURE_ENGINE_RECORD_STOPPED => CaptureEngineEventVariant::RecordStopped,
            MF_CAPTURE_ENGINE_OUTPUT_MEDIA_TYPE_SET => {
                CaptureEngineEventVariant::OutputMediaTypeSet
            }
            MF_CAPTURE_SINK_PREPARED => CaptureEngineEventVariant::SinkPrepared,
            MF_CAPTURE_SOURCE_CURRENT_DEVICE_MEDIA_TYPE_SET => {
                CaptureEngineEventVariant::SourceCurrentDeviceMediaTypeSet
            }
            _ => return None,
        })
    }
}

#[derive(PartialEq, Eq, Debug, Clone, Copy)]
pub enum CaptureEngineEventVariant {
    Initialized,
    Error,
    PreviewStarted,
    AllEffectsRemoved,
    CameraStreamBlocked,
    CameraStreamUnblocked,
    EffectAdded,
    EffectRemoved,
    PhotoTaken,
    PreviewStopped,
    RecordStarted,
    RecordStopped,
    SinkPrepared,
    SourceCurrentDeviceMediaTypeSet,
    OutputMediaTypeSet,
}

fn wait_for_event(
    rx: &Receiver<CaptureEngineEvent>,
    variant: CaptureEngineEventVariant,
) -> Result<CaptureEngineEvent, windows_core::HRESULT> {
    rx.iter()
        .find_map(|e| match e.variant() {
            Some(v) if v == variant => Some(Ok(e)),
            Some(CaptureEngineEventVariant::Error) => {
                Some(Err(unsafe { e.0.GetStatus() }.unwrap()))
            }
            _ => None,
        })
        .ok_or(windows_core::HRESULT::from_win32(
            MF_E_INVALIDREQUEST.0 as u32,
        ))
        .and_then(|v| v)
}
