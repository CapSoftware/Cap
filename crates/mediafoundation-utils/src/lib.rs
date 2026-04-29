#![cfg(windows)]

use std::{
    ops::{Deref, DerefMut},
    ptr::null_mut,
};
use windows::{
    Win32::{
        Foundation::HANDLE,
        Media::MediaFoundation::{IMFMediaBuffer, MFSTARTUP_FULL, MFStartup},
        System::{
            Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW},
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
        },
    },
    core::{PCWSTR, Result},
};

pub const MF_VERSION: u32 = 131184;

pub fn thread_init() {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let _ = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) };
}

pub struct MmcssAudioHandle {
    handle: HANDLE,
}

impl MmcssAudioHandle {
    pub fn register_audio() -> Option<Self> {
        let task_name: Vec<u16> = "Audio\0".encode_utf16().collect();
        let mut task_index: u32 = 0;
        match unsafe { AvSetMmThreadCharacteristicsW(PCWSTR(task_name.as_ptr()), &mut task_index) }
        {
            Ok(handle) if !handle.is_invalid() => Some(Self { handle }),
            _ => None,
        }
    }
}

impl Drop for MmcssAudioHandle {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            let _ = unsafe { AvRevertMmThreadCharacteristics(self.handle) };
        }
    }
}

pub trait IMFMediaBufferExt {
    fn lock(&self) -> Result<IMFMediaBufferLock<'_>>;
    fn lock_for_write(&self) -> Result<IMFMediaBufferLock<'_>>;
}

impl IMFMediaBufferExt for IMFMediaBuffer {
    fn lock(&self) -> Result<IMFMediaBufferLock<'_>> {
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

    fn lock_for_write(&self) -> Result<IMFMediaBufferLock<'_>> {
        let mut bytes_ptr = null_mut();
        let mut max_length = 0;

        unsafe {
            self.Lock(&mut bytes_ptr, Some(&mut max_length), None)?;
        }

        Ok(IMFMediaBufferLock {
            source: self,
            bytes: unsafe { std::slice::from_raw_parts_mut(bytes_ptr, max_length as usize) },
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
