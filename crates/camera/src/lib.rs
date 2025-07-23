#![cfg(any(windows, target_os = "macos"))]

use std::{
    fmt::{Debug, Display},
    ops::Deref,
};

#[cfg(target_os = "macos")]
mod macos;
// #[cfg(target_os = "macos")]
// use macos::*;

mod windows;
use windows::*;

#[derive(Debug, Clone)]
pub struct CameraInfo {
    model_id: ModelID,
    display_name: String,
}

impl Deref for CameraInfo {
    type Target = ModelID;

    fn deref(&self) -> &Self::Target {
        self.model_id()
    }
}

impl CameraInfo {
    pub fn model_id(&self) -> &ModelID {
        &self.model_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

pub fn list_cameras() -> Vec<CameraInfo> {
    list_cameras_impl()
}

#[cfg(windows)]
pub type NativeFormat = cap_camera_windows::VideoFormatInner;

#[derive(Debug)]
pub struct FormatInfo {
    width: u32,
    height: u32,
    frame_rate: f32,
}

impl FormatInfo {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn frame_rate(&self) -> f32 {
        (self.frame_rate * 100.0).round() / 100.0
    }
}

pub struct Format {
    native: NativeFormat,
    info: FormatInfo,
}

impl Format {
    pub fn native(&self) -> &NativeFormat {
        &self.native
    }
}

impl Deref for Format {
    type Target = FormatInfo;

    fn deref(&self) -> &Self::Target {
        &self.info
    }
}

impl Debug for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Format")
            .field("info", &self.info)
            .field("native", {
                #[cfg(target_os = "macos")]
                {
                    &"AVFoundation"
                }
            })
            .finish()
    }
}

// Modelled after Chromium
#[derive(Debug, Clone, PartialEq)]
pub struct ModelID {
    vid: String,
    pid: String,
}

impl ModelID {
    pub fn formats(&self) -> Option<Vec<Format>> {
        self.formats_impl()
    }
}

impl Display for ModelID {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", &self.vid, &self.pid)
    }
}

// Capture

#[derive(thiserror::Error, Debug)]
pub enum StartCaptureError {
    #[error("Device not found")]
    DeviceNotFound,
    #[cfg(target_os = "macos")]
    #[error("{0}")]
    Native(AVFoundationError),
}

pub struct CapturedFrame(NativeCapturedFrame);

impl CapturedFrame {
    /// Creates an ffmpeg video frame from the native frame.
    /// Only size, format, and data are set.
    pub fn to_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ToFfmpegError> {
        self.0.to_ffmpeg()
    }

    pub fn native(&self) -> &NativeCapturedFrame {
        &self.0
    }
}

impl CameraInfo {
    pub fn start_capturing(
        &self,
        format: Format,
        callback: impl FnMut(CapturedFrame) + 'static,
    ) -> Result<RecordingHandle, StartCaptureError> {
        #[cfg(target_os = "macos")]
        {
            Ok(RecordingHandle {
                native: start_capturing_impl(self, format, Box::new(callback))?,
            })
        }
    }
}

pub struct RecordingHandle {
    native: NativeRecordingHandle,
}

impl RecordingHandle {
    pub fn stop_capturing(self) {
        self.native.stop_capturing();
    }
}
