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
// FOURCCMap GUID for 'NV21' - identical for both DirectShow MEDIASUBTYPE and Media Foundation
const MEDIASUBTYPE_NV21: GUID = GUID::from_u128(0x3132564e_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_RGB565: GUID = GUID::from_u128(0x00000017_0000_0010_8000_00aa00389b71);
const MF_VIDEO_FORMAT_P010: GUID = GUID::from_u128(0x30313050_0000_0010_8000_00aa00389b71);

const MEDIASUBTYPE_Y800: GUID = GUID::from_u128(0x30303859_0000_0010_8000_00aa00389b71);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceCategory {
    Physical,
    Virtual,
    CaptureCard,
}

impl DeviceCategory {
    pub fn is_virtual(&self) -> bool {
        matches!(self, DeviceCategory::Virtual)
    }

    pub fn is_capture_card(&self) -> bool {
        matches!(self, DeviceCategory::CaptureCard)
    }
}

const VIRTUAL_CAMERA_PATTERNS: &[&str] = &[
    "obs",
    "virtual",
    "snap camera",
    "manycam",
    "xsplit",
    "streamlabs",
    "droidcam",
    "iriun",
    "epoccam",
    "ndi",
    "newtek",
    "camtwist",
    "mmhmm",
    "chromacam",
    "vtuber",
    "prism live",
    "camo",
    "avatarify",
    "facerig",
    "nvidia broadcast",
];

const CAPTURE_CARD_PATTERNS: &[&str] = &[
    "elgato",
    "avermedia",
    "magewell",
    "blackmagic",
    "decklink",
    "intensity",
    "ultrastudio",
    "atomos",
    "hauppauge",
    "startech",
    "j5create",
    "razer ripsaw",
    "pengo",
    "evga xr1",
    "nzxt signal",
    "genki shadowcast",
    "cam link",
    "live gamer",
    "game capture",
];

fn detect_device_category(name: &OsStr, model_id: Option<&str>) -> DeviceCategory {
    let name_lower = name.to_string_lossy().to_lowercase();
    let model_lower = model_id.map(|m| m.to_lowercase());

    let matches_pattern = |patterns: &[&str]| {
        patterns.iter().any(|pattern| {
            name_lower.contains(pattern)
                || model_lower.as_ref().is_some_and(|m| m.contains(pattern))
        })
    };

    if matches_pattern(CAPTURE_CARD_PATTERNS) {
        DeviceCategory::CaptureCard
    } else if matches_pattern(VIRTUAL_CAMERA_PATTERNS) {
        DeviceCategory::Virtual
    } else {
        DeviceCategory::Physical
    }
}

#[derive(Debug, Clone)]
pub struct FormatPreference {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
    pub format_priority: Vec<PixelFormat>,
}

impl FormatPreference {
    pub fn new(width: u32, height: u32, frame_rate: f32) -> Self {
        Self {
            width,
            height,
            frame_rate,
            format_priority: vec![
                PixelFormat::NV12,
                PixelFormat::YUYV422,
                PixelFormat::UYVY422,
                PixelFormat::YUV420P,
                PixelFormat::MJPEG,
                PixelFormat::RGB32,
            ],
        }
    }

    pub fn with_format_priority(mut self, priority: Vec<PixelFormat>) -> Self {
        self.format_priority = priority;
        self
    }

    pub fn for_hardware_encoding() -> Self {
        Self::new(1920, 1080, 30.0).with_format_priority(vec![
            PixelFormat::NV12,
            PixelFormat::YUYV422,
            PixelFormat::UYVY422,
            PixelFormat::YUV420P,
        ])
    }

    pub fn for_capture_card() -> Self {
        Self::new(1920, 1080, 60.0).with_format_priority(vec![
            PixelFormat::NV12,
            PixelFormat::YUYV422,
            PixelFormat::UYVY422,
            PixelFormat::P010,
        ])
    }
}

impl Default for FormatPreference {
    fn default() -> Self {
        Self::new(1920, 1080, 30.0)
    }
}

#[derive(Clone)]
pub struct VideoDeviceInfo {
    id: OsString,
    name: OsString,
    model_id: Option<String>,
    category: DeviceCategory,
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

    pub fn category(&self) -> DeviceCategory {
        self.category
    }

    pub fn is_virtual_camera(&self) -> bool {
        self.category.is_virtual()
    }

    pub fn is_capture_card(&self) -> bool {
        self.category.is_capture_card()
    }

    pub fn is_high_bandwidth(&self) -> bool {
        if !self.is_capture_card() {
            return false;
        }
        self.formats().iter().any(|f| {
            let pixels = f.width() as u64 * f.height() as u64;
            let fps = f.frame_rate() as u64;
            pixels >= 3840 * 2160 && fps >= 30
        })
    }

    pub fn max_resolution(&self) -> Option<(u32, u32)> {
        self.formats()
            .iter()
            .map(|f| (f.width(), f.height()))
            .max_by_key(|(w, h)| (*w as u64) * (*h as u64))
    }

    pub fn find_best_format(&self, preference: &FormatPreference) -> Option<VideoFormat> {
        let formats = self.formats();
        if formats.is_empty() {
            return None;
        }

        let target_pixels = preference.width as u64 * preference.height as u64;

        let score_format = |f: &VideoFormat| {
            let format_priority = preference
                .format_priority
                .iter()
                .position(|&pf| pf == f.pixel_format())
                .map(|pos| 1000 - pos as i32)
                .unwrap_or(0);

            let pixels = f.width() as u64 * f.height() as u64;
            let resolution_score = if pixels == target_pixels {
                500
            } else if pixels > target_pixels {
                400 - ((pixels - target_pixels) / 10000).min(300) as i32
            } else {
                300 - ((target_pixels - pixels) / 10000).min(200) as i32
            };

            let fps_diff = (f.frame_rate() - preference.frame_rate).abs();
            let fps_score = 100 - (fps_diff * 10.0).min(100.0) as i32;

            format_priority + resolution_score + fps_score
        };

        formats.into_iter().max_by_key(score_format)
    }

    pub fn find_format_with_fallback(&self, preference: &FormatPreference) -> Option<VideoFormat> {
        if let Some(format) = self.find_best_format(preference) {
            return Some(format);
        }

        let fallback_formats = [
            PixelFormat::NV12,
            PixelFormat::YUYV422,
            PixelFormat::UYVY422,
            PixelFormat::MJPEG,
            PixelFormat::RGB32,
            PixelFormat::YUV420P,
        ];

        let formats = self.formats();
        for fallback_pixel_format in fallback_formats {
            if let Some(format) = formats
                .iter()
                .filter(|f| f.pixel_format() == fallback_pixel_format)
                .max_by_key(|f| {
                    let res_score = (f.width() as i32).min(preference.width as i32)
                        + (f.height() as i32).min(preference.height as i32);
                    let fps_score =
                        (100.0 - (f.frame_rate() - preference.frame_rate).abs().min(100.0)) as i32;
                    res_score + fps_score
                })
            {
                return Some(format.clone());
            }
        }

        formats.into_iter().next()
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
                                is_bottom_up: false,
                                pixel_format: format.pixel_format,
                                timestamp: data.timestamp,
                                perf_counter: data.perf_counter,
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

                        let bi_height = video_info.bmiHeader.biHeight;
                        let is_bottom_up = bi_height > 0;
                        let height = bi_height.unsigned_abs() as usize;

                        callback(Frame {
                            inner: FrameInner::DirectShow(sample.clone()),
                            pixel_format: format,
                            width: video_info.bmiHeader.biWidth as usize,
                            height,
                            is_bottom_up,
                            timestamp: data.timestamp,
                            perf_counter: data.perf_counter,
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
    pub is_bottom_up: bool,
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
            let category = detect_device_category(&name, model_id.as_deref());

            Ok::<_, windows_core::Error>(VideoDeviceInfo {
                name,
                id,
                model_id,
                category,
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
            let category = detect_device_category(&name, model_id.as_deref());

            Some(VideoDeviceInfo {
                name,
                id,
                model_id,
                category,
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
                t if t == MEDIASUBTYPE_NV21 => PixelFormat::NV21,
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
                t if t == MEDIASUBTYPE_NV21 => PixelFormat::NV21,
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
