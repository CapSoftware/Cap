#![cfg(windows)]

use std::{
    ffi::OsString,
    fmt::Display,
    mem::MaybeUninit,
    ops::{Deref, DerefMut},
    os::windows::ffi::OsStringExt,
    slice::from_raw_parts,
};

use windows::Win32::Media::MediaFoundation::*;
use windows_core::PWSTR;

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

pub struct Device {
    activate: IMFActivate,
    media_source: IMFMediaSource,
}

impl Device {
    pub fn name(&self) -> Option<OsString> {
        let mut raw = PWSTR(&mut 0);
        let mut length = 0;
        unsafe {
            self.activate
                .GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut raw, &mut length)
                .map(|_| OsString::from_wide(from_raw_parts(raw.0, length as usize)))
                .ok()
        }
    }

    pub fn id(&self) -> Option<OsString> {
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
                .ok()
        }
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
                .unwrap_or_else(|| format!("Unknown device name"))
        )
    }
}

pub struct SourceReader {
    inner: IMFSourceReader,
}

impl SourceReader {
    pub fn native_media_types(&self, stream_index: u32) -> Vec<IMFMediaType> {
        let mut i = 0;
        let mut ret = vec![];

        while let Ok(typ) = unsafe { self.inner.GetNativeMediaType(stream_index, i) } {
            i += 1;
            ret.push(typ);
        }

        ret
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
