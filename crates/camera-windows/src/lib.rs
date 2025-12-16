#![cfg(windows)]

use cap_camera_directshow::{AM_MEDIA_TYPEVideoExt, AMMediaType};
use cap_mediafoundation_utils::*;
use std::{
    ffi::{OsStr, OsString},
    fmt::{Debug, Display},
    ops::Deref,
    time::Duration,
};

use windows::Win32::Media::{DirectShow::*, KernelStreaming::*, MediaFoundation::*};
use windows_core::GUID;

const MF_VIDEO_FORMAT_L8: GUID = GUID::from_u128(0x00000050_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_L16: GUID = GUID::from_u128(0x00000051_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_NV21: GUID = GUID::from_u128(0x3132564e_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_RGB565: GUID = GUID::from_u128(0x00000017_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_P010: GUID = GUID::from_u128(0x30313050_0000_0010_8000_00aa00389b71);

const MEDIASUBTYPE_Y800: GUID = GUID::from_u128(0x30303859_0000_0010_8000_00aa00389b71);

#[derive(Clone)]
pub struct VideoDeviceInfo {
    id: OsString,
    name: OsString,
    model_id: Option<String>,
    // formats: Vec<VideoFormat>,
    inner: VideoDeviceInfoInner,
}

pub enum CaptureHandle {
    MediaFoundation(cap_camera_mediafoundation::CaptureHandle),
    DirectShow(cap_camera_directshow::CaptureHandle),
}

impl CaptureHandle {
    pub fn stop_capturing(self) -> windows_core::Result<()> {
        match self {
            CaptureHandle::MediaFoundation(handle) => handle.stop_capturing(),
            CaptureHandle::DirectShow(handle) => handle.stop_capturing(),
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum StartCapturingError {
    #[error("{0}")]
    MediaFoundation(#[from] cap_camera_mediafoundation::StartCapturingError),
    #[error("{0}")]
    DirectShow(#[from] cap_camera_directshow::StartCapturingError),
    #[error("Format/{0}")]
    Format(#[from] VideoFormatError),
}

impl VideoDeviceInfo {
    pub fn id(&self) -> &OsStr {
        &self.id
    }

    pub fn name(&self) -> &OsStr {
        &self.name
    }

    pub fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
    }

    pub fn is_mf(&self) -> bool {
        matches!(self.inner, VideoDeviceInfoInner::MediaFoundation { .. })
    }

    fn name_and_model(&self) -> String {
        if let Some(model_id) = &self.model_id {
            format!("{} ({model_id})", self.name.to_string_lossy())
        } else {
            self.name.to_string_lossy().to_string()
        }
    }

    pub fn start_capturing(
        self,
        format: &VideoFormatInner,
        mut callback: impl FnMut(Frame) + 'static,
    ) -> Result<CaptureHandle, StartCapturingError> {
        let res = match (self.inner, &format) {
            (
                VideoDeviceInfoInner::MediaFoundation { device },
                VideoFormatInner::MediaFoundation(mf_format),
            ) => {
                let format = VideoFormat::new_mf(mf_format.clone())?;

                let handle = device.start_capturing(
                    mf_format,
                    Box::new(move |data| {
                        let sample = &data.sample;
                        let len = unsafe { sample.GetBufferCount() }.unwrap();
                        for i in 0..len {
                            let Ok(buffer) = (unsafe { sample.GetBufferByIndex(i) }) else {
                                continue;
                            };

                            callback(Frame {
                                inner: FrameInner::MediaFoundation(buffer),
                                width: format.width() as usize,
                                height: format.height() as usize,
                                pixel_format: format.pixel_format,
                                timestamp: data.timestamp,
                                perf_counter: data.perf_counter,
                                // capture_begin_time: Some(data.capture_begin_time),
                            })
                        }
                    }),
                )?;

                CaptureHandle::MediaFoundation(handle)
            }
            (VideoDeviceInfoInner::DirectShow(device), VideoFormatInner::DirectShow(format)) => {
                let handle = device.start_capturing(
                    format,
                    Box::new(move |data| {
                        let sample = data.sample;
                        let media_type = data.media_type;

                        let video_info = unsafe {
                            &*(media_type.pbFormat as *const _ as *const KS_VIDEOINFOHEADER)
                        };

                        let Some(format) = DSPixelFormat::new(media_type).map(|v| v.format) else {
                            return;
                        };

                        callback(Frame {
                            inner: FrameInner::DirectShow(sample.clone()),
                            pixel_format: format,
                            width: video_info.bmiHeader.biWidth as usize,
                            height: video_info.bmiHeader.biHeight as usize,
                            timestamp: data.timestamp,
                            perf_counter: data.perf_counter,
                            // capture_begin_time: None,
                        });
                    }),
                )?;

                CaptureHandle::DirectShow(handle)
            }
            _ => todo!(),
        };

        Ok(res)
    }

    pub fn formats(&self) -> Vec<VideoFormat> {
        match &self.inner {
            VideoDeviceInfoInner::MediaFoundation { device } => device
                .formats()
                .map(|formats| {
                    formats
                        .filter_map(|t| VideoFormat::new_mf(t).ok())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            VideoDeviceInfoInner::DirectShow(device) => device
                .media_types()
                .into_iter()
                .flatten()
                .filter_map(|media_type| VideoFormat::new_ds(media_type).ok())
                .collect::<Vec<_>>(),
        }
    }
}

impl Debug for VideoDeviceInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceInfo")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("format_count", &self.formats().len())
            .field("inner", &self.inner)
            .finish()
    }
}

#[derive(Debug)]
pub struct Frame {
    pub pixel_format: PixelFormat,
    pub width: usize,
    pub height: usize,
    // pub reference_time: Instant,
    pub timestamp: Duration,
    pub perf_counter: i64,
    inner: FrameInner,
}

impl Frame {
    pub fn bytes<'a>(&'a self) -> windows_core::Result<FrameBytes<'a>> {
        match &self.inner {
            FrameInner::DirectShow(sample) => {
                let length = unsafe { sample.GetActualDataLength() };
                let ptr = unsafe { sample.GetPointer() }?;

                let slice = unsafe { std::slice::from_raw_parts::<'a>(ptr, length as usize) };
                Ok(FrameBytes::DirectShow(slice))
            }
            FrameInner::MediaFoundation(buffer) => Ok(FrameBytes::MediaFoundation(buffer.lock()?)),
        }
    }
}

pub enum FrameBytes<'a> {
    DirectShow(&'a [u8]),
    MediaFoundation(IMFMediaBufferLock<'a>),
}

impl<'a> Deref for FrameBytes<'a> {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        match self {
            FrameBytes::DirectShow(bytes) => bytes,
            FrameBytes::MediaFoundation(lock) => lock.deref(),
        }
    }
}

#[derive(Debug)]
pub enum FrameInner {
    MediaFoundation(IMFMediaBuffer),
    DirectShow(IMediaSample),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PixelFormat {
    ARGB,
    RGB24,
    RGB32,
    YUV420P,
    NV12,
    NV21,
    YUYV422,
    UYVY422,
    MJPEG,
    YV12,
    BGR24,
    GRAY8,
    GRAY16,
    RGB565,
    P010,
    H264,
}

#[derive(Clone)]
enum VideoDeviceInfoInner {
    MediaFoundation {
        device: cap_camera_mediafoundation::Device,
    },
    DirectShow(cap_camera_directshow::VideoInputDevice),
}

impl Debug for VideoDeviceInfoInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DirectShow(_) => write!(f, "DirectShow"),
            Self::MediaFoundation { .. } => write!(f, "MediaFoundation"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GetDevicesError {
    #[error("MediaFoundation: {0}")]
    MFDeviceEnumerationFailed(windows_core::Error),
    #[error("DirectShow:: {0}")]
    DSDeviceEnumerationFailed(windows_core::Error),
}

pub fn get_devices() -> Result<Vec<VideoDeviceInfo>, GetDevicesError> {
    let _ = cap_camera_directshow::initialize_directshow();
    let _ = cap_camera_mediafoundation::initialize_mediafoundation();

    let mf_devices = cap_camera_mediafoundation::DeviceSourcesIterator::new()
        .map_err(GetDevicesError::MFDeviceEnumerationFailed)?
        .map(|device| {
            let name = device.name()?;
            let id = device.id()?;
            let model_id = device.model_id();

            Ok::<_, windows_core::Error>(VideoDeviceInfo {
                name,
                id,
                model_id,
                inner: VideoDeviceInfoInner::MediaFoundation { device },
            })
        })
        .filter_map(|result| match result {
            Ok(r) => Some(r),
            Err(e) => {
                println!("Failed to load MF device info: {e}");
                None
            }
        })
        .collect::<Vec<_>>();

    let dshow_devices = cap_camera_directshow::VideoInputDeviceIterator::new()
        .map_err(GetDevicesError::DSDeviceEnumerationFailed)?
        .map(|device| {
            let id = device.id()?;
            let name = device.name()?;
            let model_id = device.model_id();

            Some(VideoDeviceInfo {
                name,
                id,
                model_id,
                inner: VideoDeviceInfoInner::DirectShow(device),
            })
        })
        .filter_map(|result| {
            if result.is_none() {
                println!("Failed to load DS device info");
            }
            result
        })
        .collect::<Vec<_>>();

    let mut devices = mf_devices;

    for dshow_device in dshow_devices {
        let name_and_model = dshow_device.name_and_model();

        let mf_device = devices
            .iter()
            .enumerate()
            .find(|(_, device)| device.is_mf() && device.name_and_model() == name_and_model);

        match mf_device {
            Some((i, mf_device)) => {
                if mf_device.formats().is_empty() {
                    devices.push(mf_device.clone());
                    devices.swap_remove(i);
                }
            }
            None => devices.push(dshow_device),
        }
    }

    Ok(devices)
}

#[derive(Debug, Clone)]
pub struct VideoFormat {
    width: u32,
    height: u32,
    frame_rate: f32,
    pixel_format: PixelFormat,
    pub inner: VideoFormatInner,
}

impl VideoFormat {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn frame_rate(&self) -> f32 {
        self.frame_rate
    }

    pub fn pixel_format(&self) -> PixelFormat {
        self.pixel_format
    }
}

#[derive(Clone)]
pub enum VideoFormatInner {
    MediaFoundation(IMFMediaType),
    DirectShow(AMMediaType),
}

impl Debug for VideoFormatInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            VideoFormatInner::MediaFoundation(_) => "MediaFoundation",
            VideoFormatInner::DirectShow(_) => "DirectShow",
        })
    }
}

#[derive(thiserror::Error, Debug)]
pub enum VideoFormatError {
    #[error("Provided format is not video")]
    NotVideo,
    #[error("Invalid pixel format '{0:?}'")]
    InvalidPixelFormat(GUID),
    #[error("{0}")]
    Other(#[from] windows_core::Error),
}

impl VideoFormat {
    fn new_mf(inner: IMFMediaType) -> Result<Self, VideoFormatError> {
        if unsafe { inner.GetMajorType()? } != MFMediaType_Video {
            return Err(VideoFormatError::NotVideo);
        }

        let size = unsafe { inner.GetUINT64(&MF_MT_FRAME_SIZE)? };
        let width = (size >> 32) as u32;
        let height = (size & 0xFFFFFFFF) as u32;

        let frame_rate_ratio = {
            let frame_rate = unsafe { inner.GetUINT64(&MF_MT_FRAME_RATE)? };
            let numerator = (frame_rate >> 32) as u32;
            let denominator = frame_rate as u32;
            (numerator, denominator)
        };
        let frame_rate = frame_rate_ratio.0 as f32 / frame_rate_ratio.1 as f32;

        let subtype = unsafe { inner.GetGUID(&MF_MT_SUBTYPE)? };

        Ok(Self {
            width,
            height,
            frame_rate,
            pixel_format: MFPixelFormat::new(subtype)
                .ok_or(VideoFormatError::InvalidPixelFormat(subtype))?
                .format,
            inner: VideoFormatInner::MediaFoundation(inner),
        })
    }

    fn new_ds(inner: AMMediaType) -> Result<Self, VideoFormatError> {
        if inner.majortype != MFMediaType_Video {
            return Err(VideoFormatError::NotVideo);
        }

        let video_info = unsafe { inner.video_info() };

        Ok(VideoFormat {
            width: video_info.bmiHeader.biWidth as u32,
            height: video_info.bmiHeader.biHeight as u32,
            frame_rate: ((10_000_000.0 / video_info.AvgTimePerFrame as f32) * 100.0).round()
                / 100.0,
            pixel_format: DSPixelFormat::new(&inner)
                .ok_or(VideoFormatError::InvalidPixelFormat(inner.subtype))?
                .format,
            inner: VideoFormatInner::DirectShow(inner),
        })
    }
}

impl Display for VideoFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}x{} {}fps", self.width, self.height, self.frame_rate)?;
        write!(f, " {:?}", self.pixel_format)
    }
}

struct MFPixelFormat {
    format: PixelFormat,
    #[allow(unused)]
    mf: GUID,
}

impl MFPixelFormat {
    fn new(subtype: GUID) -> Option<Self> {
        let get_format = || {
            Some(match subtype {
                t if t == MFVideoFormat_I420 || t == MFVideoFormat_IYUV => PixelFormat::YUV420P,
                t if t == MFVideoFormat_RGB24 => PixelFormat::RGB24,
                t if t == MFVideoFormat_RGB32 => PixelFormat::RGB32,
                t if t == MFVideoFormat_YUY2 => PixelFormat::YUYV422,
                t if t == MFVideoFormat_UYVY => PixelFormat::UYVY422,
                t if t == MFVideoFormat_ARGB32 => PixelFormat::ARGB,
                t if t == MFVideoFormat_NV12 => PixelFormat::NV12,
                t if t == MFVideoFormat_MJPG => PixelFormat::MJPEG,
                t if t == MFVideoFormat_YV12 => PixelFormat::YV12,
                t if t == MF_VIDEO_FORMAT_L8 => PixelFormat::GRAY8,
                t if t == MF_VIDEO_FORMAT_L16 => PixelFormat::GRAY16,
                t if t == MF_VIDEO_FORMAT_NV21 => PixelFormat::NV21,
                t if t == MF_VIDEO_FORMAT_RGB565 => PixelFormat::RGB565,
                t if t == MF_VIDEO_FORMAT_P010 => PixelFormat::P010,
                t if t == MFVideoFormat_H264 => PixelFormat::H264,
                _ => return None,
            })
        };

        Some(Self {
            format: get_format()?,
            mf: subtype,
        })
    }
}

impl Deref for MFPixelFormat {
    type Target = PixelFormat;

    fn deref(&self) -> &Self::Target {
        &self.format
    }
}

struct DSPixelFormat {
    format: PixelFormat,
    #[allow(unused)]
    ds: GUID,
}

impl Deref for DSPixelFormat {
    type Target = PixelFormat;

    fn deref(&self) -> &Self::Target {
        &self.format
    }
}

impl DSPixelFormat {
    fn new(major_type: &AM_MEDIA_TYPE) -> Option<Self> {
        let subtype = major_type.subtype;

        let get_ffmpeg = || {
            Some(match subtype {
                t if t == MEDIASUBTYPE_I420 || t == MEDIASUBTYPE_IYUV => PixelFormat::YUV420P,
                t if t == MEDIASUBTYPE_RGB24 => PixelFormat::RGB24,
                t if t == MEDIASUBTYPE_RGB32 => PixelFormat::RGB32,
                t if t == MEDIASUBTYPE_YUY2 => PixelFormat::YUYV422,
                t if t == MEDIASUBTYPE_UYVY => PixelFormat::UYVY422,
                t if t == MEDIASUBTYPE_ARGB32 => PixelFormat::ARGB,
                t if t == MEDIASUBTYPE_NV12 => PixelFormat::NV12,
                t if t == MEDIASUBTYPE_MJPG => PixelFormat::MJPEG,
                t if t == MEDIASUBTYPE_YV12 => PixelFormat::YV12,
                t if t == MEDIASUBTYPE_Y800 || t == MEDIASUBTYPE_RGB8 => PixelFormat::GRAY8,
                t if t == MF_VIDEO_FORMAT_NV21 => PixelFormat::NV21,
                t if t == MEDIASUBTYPE_RGB565 => PixelFormat::RGB565,
                _ => return None,
            })
        };

        Some(Self {
            format: get_ffmpeg()?,
            ds: subtype,
        })
    }
}
