use std::{
    ops::{Deref, DerefMut},
    ptr::null_mut,
};
use windows::{Win32::Media::MediaFoundation::IMFMediaBuffer, core::Result};

pub trait IMFMediaBufferExt {
    fn lock(&self) -> Result<IMFMediaBufferLock<'_>>;
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
