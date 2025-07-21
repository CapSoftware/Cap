#![cfg(windows)]

use std::{
    ffi::OsString,
    fmt::Display,
    mem::MaybeUninit,
    ops::{Deref, DerefMut},
    os::windows::ffi::OsStringExt,
    ptr::null_mut,
    slice::from_raw_parts,
};

use windows::Win32::{Media::MediaFoundation::*, System::Com::CoInitialize};
use windows_core::PWSTR;

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

            return Some(Device {
                media_source: unsafe { device.ActivateObject::<IMFMediaSource>() }
                    .expect("media source doesn't have IMFMediaSource"),
                activate: device.clone(),
            });
        }
    }
}

#[derive(Clone)]
pub struct Device {
    activate: IMFActivate,
    media_source: IMFMediaSource,
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
            .and_then(|v| get_device_model_id(&*v.to_string_lossy()))
    }

    pub fn create_source_reader(&self) -> windows_core::Result<SourceReader> {
        unsafe {
            MFCreateSourceReaderFromMediaSource(&self.media_source, None)
                .map(|inner| SourceReader { inner })
        }
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
                .unwrap_or_else(|_| format!("Unknown device name"))
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
    ) -> windows_core::Result<NativeMediaTypesIterator> {
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
            let bytes = self.0.GetTotalLength().unwrap();
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
        let Some(ret) = unsafe { self.reader.GetNativeMediaType(self.stream_index, self.i) }.ok()
        else {
            return None;
        };

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
    const VID_PID_SIZE: usize = 4;

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
    fn lock(&self) -> windows_core::Result<IMFMediaBufferLock>;
}

impl IMFMediaBufferExt for IMFMediaBuffer {
    fn lock(&self) -> windows_core::Result<IMFMediaBufferLock> {
        let mut bytes_ptr = null_mut();
        let mut size = 0;

        unsafe {
            self.Lock(&mut bytes_ptr, None, Some(&mut size))?;
        }

        Ok(IMFMediaBufferLock {
            source: self,
            bytes: unsafe { std::slice::from_raw_parts_mut(bytes_ptr as *mut u8, size as usize) },
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
        &self.bytes
    }
}

impl<'a> DerefMut for IMFMediaBufferLock<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.bytes
    }
}
