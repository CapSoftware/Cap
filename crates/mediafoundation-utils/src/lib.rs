#![cfg(windows)]

use std::{
    ops::{Deref, DerefMut},
    ptr::null_mut,
};
use windows::{
    Win32::{
        Media::MediaFoundation::{IMFMediaBuffer, MFSTARTUP_FULL, MFStartup},
        System::{
            LibraryLoader::GetModuleHandleW,
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
        },
    },
    core::{Result, PCWSTR},
};

// This is the value for Win7+
pub const MF_VERSION: u32 = 131184;

/// Custom error type for initialization failures
#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("Third-party software conflict detected: {software}. {message}")]
    ThirdPartyConflict { software: String, message: String },
    #[error("Failed to initialize Windows Runtime: {0}")]
    RoInitializeFailed(windows::core::Error),
    #[error("Failed to initialize Media Foundation: {0}")]
    MFStartupFailed(windows::core::Error),
}

/// Detects if Wondershare DemoCreator's hook DLL is loaded in the process.
/// This DLL is known to cause crashes when interfering with WinRT initialization.
pub fn detect_wondershare_democreator() -> bool {
    unsafe {
        // Check for CaptureGameHook_64.dll (64-bit version)
        let dll_name = windows::core::w!("CaptureGameHook_64.dll");
        let handle = GetModuleHandleW(PCWSTR(dll_name.as_ptr())).ok();
        
        if handle.is_some() {
            return true;
        }
        
        // Also check for the 32-bit version just in case
        let dll_name_32 = windows::core::w!("CaptureGameHook.dll");
        let handle_32 = GetModuleHandleW(PCWSTR(dll_name_32.as_ptr())).ok();
        
        handle_32.is_some()
    }
}

/// Checks for known incompatible third-party software before initializing.
/// Returns an error if incompatible software is detected.
pub fn check_compatibility() -> Result<(), InitError> {
    if detect_wondershare_democreator() {
        return Err(InitError::ThirdPartyConflict {
            software: "Wondershare DemoCreator".to_string(),
            message: "The Wondershare DemoCreator hook DLL (CaptureGameHook_64.dll) is interfering with Cap's screen capture system. Please close Wondershare DemoCreator and try again.".to_string(),
        });
    }
    
    Ok(())
}

/// Initializes Windows Runtime and Media Foundation for the current thread.
/// Should be called on threads that use WinRT or Media Foundation APIs.
pub fn thread_init() {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let _ = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) };
}

/// Initializes Windows Runtime and Media Foundation for the current thread with error handling.
/// Returns an error if initialization fails or if incompatible software is detected.
pub fn thread_init_checked() -> Result<(), InitError> {
    // First check for known incompatible software
    check_compatibility()?;
    
    // Initialize Windows Runtime
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(InitError::RoInitializeFailed)?;
    
    // Initialize Media Foundation
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
        .map_err(InitError::MFStartupFailed)?;
    
    Ok(())
}

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
