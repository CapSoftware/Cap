#![cfg(any(windows, target_os = "macos", target_os = "linux"))]

use std::{
    fmt::{Debug, Display},
    ops::Deref,
    time::Duration,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::*;

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CameraInfo {
    device_id: String,
    model_id: Option<ModelID>,
    display_name: String,
}

impl CameraInfo {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn model_id(&self) -> Option<&ModelID> {
        self.model_id.as_ref()
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

pub fn list_cameras() -> impl Iterator<Item = CameraInfo> {
    list_cameras_impl()
}

#[cfg(windows)]
pub type NativeFormat = cap_camera_windows::VideoFormatInner;

#[derive(Debug, Clone)]
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

#[derive(Clone)]
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
                #[cfg(windows)]
                {
                    use cap_camera_windows::VideoFormatInner;

                    match &self.native {
                        VideoFormatInner::DirectShow(_) => &"DirectShow",
                        VideoFormatInner::MediaFoundation(_) => &"MediaFoundation",
                    }
                }
                #[cfg(target_os = "linux")]
                {
                    &"V4L2"
                }
            })
            .finish()
    }
}

/// A unique identifier for a camera device.
/// This is modelled after Chromium's  VideoCaptureDeviceDescriptor::model_id,
/// being a combination of the vendor ID and product ID.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelID {
    vid: String,
    pid: String,
}

#[cfg_attr(feature = "specta", derive(specta::Type))]
#[cfg_attr(feature = "specta", specta(remote = ModelID))]
#[allow(dead_code)] // It's never constructed but it's a remote impl
struct ModelIDType(String);

#[cfg(feature = "serde")]
impl serde::Serialize for ModelID {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_str(&format_args!("{}:{}", &self.vid, &self.pid))
    }
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for ModelID {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        let (vid, pid) = s.split_once(":").unwrap();
        Ok(ModelID {
            vid: vid.to_string(),
            pid: pid.to_string(),
        })
    }
}

impl TryFrom<String> for ModelID {
    type Error = ();

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let (vid, pid) = value.split_once(":").ok_or(())?;
        Ok(ModelID {
            vid: vid.to_string(),
            pid: pid.to_string(),
        })
    }
}

impl Display for ModelID {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", &self.vid, &self.pid)
    }
}

// Capture

#[derive(thiserror::Error, Debug)]
pub enum StartCapturingError {
    #[cfg(windows)]
    #[error("GetDevicesFailed/{0}")]
    GetDevicesFailed(#[from] cap_camera_windows::GetDevicesError),
    #[error("Device not found")]
    DeviceNotFound,
    #[cfg(windows)]
    #[error("{0}")]
    Inner(#[from] cap_camera_windows::StartCapturingError),
    #[cfg(target_os = "macos")]
    #[error("{0}")]
    Native(#[from] AVFoundationError),
    #[cfg(windows)]
    #[error("{0}")]
    Native(windows_core::Error),
    #[cfg(target_os = "linux")]
    #[error("Linux camera error: {0}")]
    LinuxError(String),
}

#[derive(Debug)]
pub struct CapturedFrame {
    native: NativeCapturedFrame,
    // pub reference_time: Instant,
    pub timestamp: Duration,
    // pub capture_begin_time: Option<Instant>,
}

impl CapturedFrame {
    pub fn native(&self) -> &NativeCapturedFrame {
        &self.native
    }
}

impl CameraInfo {
    pub fn formats(&self) -> Option<Vec<Format>> {
        self.formats_impl()
    }

    pub fn start_capturing(
        &self,
        format: Format,
        callback: impl FnMut(CapturedFrame) + Send + 'static,
    ) -> Result<CaptureHandle, StartCapturingError> {
        Ok(CaptureHandle {
            native: Some(start_capturing_impl(self, format, Box::new(callback))?),
        })
    }
}

#[must_use = "must be held for the duration of the recording"]
pub struct CaptureHandle {
    native: Option<NativeCaptureHandle>,
}

impl CaptureHandle {
    pub fn stop_capturing(mut self) -> Result<(), String> {
        if let Some(feed) = self.native.take() {
            feed.stop_capturing()?;
        }
        Ok(())
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        if let Some(feed) = self.native.take() {
            feed.stop_capturing().ok();
        }
    }
}
