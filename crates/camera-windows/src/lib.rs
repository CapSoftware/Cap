#![cfg(windows)]

use cap_camera_directshow::{AM_MEDIA_TYPEVideoExt, AMMediaType};
use std::{
    ffi::OsString,
    fmt::{Debug, Display},
};
use windows::Win32::Media::MediaFoundation::*;
use windows_core::GUID;

#[derive(Clone)]
pub struct DeviceInfo {
    id: OsString,
    name: OsString,
    model_id: Option<String>,
    formats: Vec<VideoFormat>,
    inner: DeviceInfoInner,
}

impl Debug for DeviceInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceInfo")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("format_count", &self.formats.len())
            .field("inner", &self.inner)
            .finish()
    }
}

impl DeviceInfo {
    fn is_mf(&self) -> bool {
        matches!(self.inner, DeviceInfoInner::MediaFoundation(_))
    }

    fn name_and_model(&self) -> String {
        if let Some(model_id) = &self.model_id {
            format!("{} ({model_id})", self.name.to_string_lossy())
        } else {
            self.name.to_string_lossy().to_string()
        }
    }
}

#[derive(Clone)]
enum DeviceInfoInner {
    MediaFoundation(cap_camera_mediafoundation::Device),
    DirectShow(cap_camera_directshow::VideoInputDevice),
}

impl Debug for DeviceInfoInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DirectShow(_) => write!(f, "DirectShow"),
            Self::MediaFoundation(_) => write!(f, "MediaFoundation"),
        }
    }
}

#[derive(Debug)]
pub enum GetDevicesError {
    MFDeviceEnumerationFailed(windows_core::Error),
    DSDeviceEnumerationFailed(windows_core::Error),
}

pub fn get_devices() -> Result<Vec<DeviceInfo>, GetDevicesError> {
    let _ = cap_camera_directshow::initialize_directshow();
    let _ = cap_camera_mediafoundation::initialize_mediafoundation();

    let mf_devices = cap_camera_mediafoundation::DeviceSourcesIterator::new()
        .map_err(GetDevicesError::MFDeviceEnumerationFailed)?
        .map(|device| {
            let name = device.name()?;
            let id = device.id()?;
            let model_id = device.model_id();

            let reader = device.create_source_reader()?;
            let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

            let formats = reader
                .native_media_types(stream_index)?
                .filter_map(|t| VideoFormat::new_mf(&t).ok())
                .collect::<Vec<_>>();

            Ok::<_, windows_core::Error>(DeviceInfo {
                name,
                id,
                model_id,
                formats,
                inner: DeviceInfoInner::MediaFoundation(device),
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

            let formats = device
                .media_types()
                .into_iter()
                .flatten()
                .filter_map(|media_type| VideoFormat::new_ds(&media_type).ok())
                .collect::<Vec<_>>();

            Some(DeviceInfo {
                name,
                id,
                model_id,
                formats,
                inner: DeviceInfoInner::DirectShow(device),
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
        // dbg!(&name_and_model);

        let mf_device = devices
            .iter()
            .enumerate()
            .find(|(_, device)| device.is_mf() && device.name_and_model() == name_and_model);

        match mf_device {
            Some((i, mf_device)) => {
                if mf_device.formats.len() == 0 {
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
struct VideoFormat {
    width: u32,
    height: u32,
    frame_rate: f32,
    pixel_format: ffmpeg::format::Pixel,
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
    fn new_mf(inner: &IMFMediaType) -> Result<Self, VideoFormatError> {
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
                .as_ffmpeg(),
        })
    }

    fn new_ds(inner: &AMMediaType) -> Result<Self, VideoFormatError> {
        if inner.majortype != MFMediaType_Video {
            return Err(VideoFormatError::NotVideo);
        }

        let video_info = unsafe { inner.video_info() };

        Ok(VideoFormat {
            width: video_info.bmiHeader.biWidth as u32,
            height: video_info.bmiHeader.biHeight as u32,
            frame_rate: ((10_000_000.0 / video_info.AvgTimePerFrame as f32) * 100.0).round()
                / 100.0,
            pixel_format: DSPixelFormat::new(inner)
                .ok_or(VideoFormatError::InvalidPixelFormat(inner.subtype))?
                .as_ffmpeg(),
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
    ffmpeg: ffmpeg::format::Pixel,
    mf: GUID,
}

impl MFPixelFormat {
    fn new(subtype: GUID) -> Option<Self> {
        use ffmpeg::format::Pixel;

        let get_ffmpeg = || {
            Some(match subtype {
                t if t == MFVideoFormat_I420 || t == MFVideoFormat_IYUV => Pixel::YUV420P,
                t if t == MFVideoFormat_RGB24 => Pixel::RGB24,
                t if t == MFVideoFormat_RGB32 => Pixel::RGB32,
                t if t == MFVideoFormat_YUY2 => Pixel::YUYV422,
                t if t == MFVideoFormat_UYVY => Pixel::UYVY422,
                t if t == MFVideoFormat_ARGB32 => Pixel::ARGB,
                t if t == MFVideoFormat_NV12 => Pixel::NV12,
                _ => return None,
            })
        };

        Some(Self {
            ffmpeg: get_ffmpeg()?,
            mf: subtype,
        })
    }

    pub fn as_ffmpeg(&self) -> ffmpeg::format::Pixel {
        self.ffmpeg
    }
}

struct DSPixelFormat {
    ffmpeg: ffmpeg::format::Pixel,
    ds: GUID,
}

impl DSPixelFormat {
    fn new(major_type: &AM_MEDIA_TYPE) -> Option<Self> {
        use ffmpeg::format::Pixel;

        let subtype = major_type.subtype;

        let get_ffmpeg = || {
            Some(match subtype {
                t if t == MEDIASUBTYPE_I420 || t == MEDIASUBTYPE_IYUV => Pixel::YUV420P,
                t if t == MEDIASUBTYPE_RGB24 => Pixel::RGB24,
                t if t == MEDIASUBTYPE_RGB32 => Pixel::RGB32,
                t if t == MEDIASUBTYPE_YUY2 => Pixel::YUYV422,
                t if t == MEDIASUBTYPE_UYVY => Pixel::UYVY422,
                t if t == MEDIASUBTYPE_ARGB32 => Pixel::ARGB,
                t if t == MEDIASUBTYPE_NV12 => Pixel::NV12,
                _ => return None,
            })
        };

        Some(Self {
            ffmpeg: get_ffmpeg()?,
            ds: subtype,
        })
    }

    pub fn as_ffmpeg(&self) -> ffmpeg::format::Pixel {
        self.ffmpeg
    }
}
