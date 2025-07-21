#![cfg(windows)]

use cap_camera_directshow::{AM_MEDIA_TYPEExt, AM_MEDIA_TYPEVideoExt, AMMediaType, SinkFilter};
use cap_camera_mediafoundation::{IMFMediaBufferExt, SourceReader};
use ffmpeg::format::Pixel;
use std::{
    ffi::{OsStr, OsString},
    fmt::{Debug, Display},
    ops::Deref,
    ptr::null_mut,
    time::Duration,
};
use windows::Win32::Media::{DirectShow::*, KernelStreaming::*, MediaFoundation::*};
use windows_core::GUID;

#[derive(Clone)]
pub struct VideoDeviceInfo {
    id: OsString,
    name: OsString,
    model_id: Option<String>,
    formats: Vec<VideoFormat>,
    inner: VideoDeviceInfoInner,
}

impl VideoDeviceInfo {
    pub fn id(&self) -> &OsStr {
        &self.id
    }

    pub fn name(&self) -> &OsStr {
        &self.name
    }

    pub fn formats(&self) -> &Vec<VideoFormat> {
        &self.formats
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

    pub fn start_capturing<'a>(
        self,
        format: &VideoFormat,
    ) -> windows_core::Result<CaptureIterator> {
        let res = match (self.inner, &format.inner) {
            (
                VideoDeviceInfoInner::MediaFoundation { device, reader },
                VideoFormatInner::MediaFoundation(mf_format),
            ) => {
                let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
                let pixel_format = format.pixel_format;
                let width = format.width as usize;
                let height = format.height as usize;

                reader
                    .set_current_media_type(stream_index, &mf_format)
                    .unwrap();
                unsafe {
                    reader.SetStreamSelection(stream_index, true).unwrap();
                }

                Box::new(std::iter::from_fn(move || {
                    let sample = match reader.try_read_sample(stream_index) {
                        Ok(v) => v?,
                        Err(e) => return Some(Err(e)),
                    };

                    let bytes = match sample.bytes() {
                        Ok(v) => v,
                        Err(e) => return Some(Err(e)),
                    };

                    Some(Ok(Frame {
                        bytes,
                        pixel_format,
                        width,
                        height,
                    }))
                })) as CaptureIterator
            }
            (
                VideoDeviceInfoInner::DirectShow(mut device),
                VideoFormatInner::DirectShow(format),
            ) => {
                let (tx, rx) = std::sync::mpsc::sync_channel(1);

                device.set_format(format)?;

                let _ = device.run(Box::new(move |buffer, media_type, _| {
                    let video_info =
                        unsafe { &*(media_type.pbFormat as *const _ as *const KS_VIDEOINFOHEADER) };

                    let Some(format) = DSPixelFormat::new(media_type).map(|v| v.format) else {
                        return;
                    };

                    let _ = tx.try_send(Frame {
                        bytes: buffer.to_vec(),
                        pixel_format: format,
                        width: video_info.bmiHeader.biWidth as usize,
                        height: video_info.bmiHeader.biHeight as usize,
                    });
                }));

                Box::new(std::iter::from_fn(move || {
                    match rx.recv_timeout(Duration::from_secs(5)) {
                        Ok(buffer) => Some(Ok(buffer)),
                        Err(e) => None,
                    }
                })) as CaptureIterator
            }
            _ => todo!(),
        };

        Ok(res)
    }
}

type CaptureIterator<'a> = Box<dyn Iterator<Item = windows_core::Result<Frame>> + 'a>;

impl Debug for VideoDeviceInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceInfo")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("format_count", &self.formats.len())
            .field("inner", &self.inner)
            .finish()
    }
}

pub struct Frame {
    pub bytes: Vec<u8>,
    pub pixel_format: PixelFormat,
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, Copy)]
pub enum PixelFormat {
    ARGB,
    RGB24,
    RGB32,
    YUV420P,
    YUYV422,
    UYVY422,
    NV12,
}

impl PixelFormat {
    pub fn as_ffmpeg(&self) -> ffmpeg::format::Pixel {
        match self {
            PixelFormat::YUV420P => Pixel::YUV420P,
            PixelFormat::RGB24 => Pixel::RGB24,
            PixelFormat::RGB32 => Pixel::RGB32,
            PixelFormat::YUYV422 => Pixel::YUYV422,
            PixelFormat::UYVY422 => Pixel::UYVY422,
            PixelFormat::ARGB => Pixel::ARGB,
            PixelFormat::NV12 => Pixel::NV12,
        }
    }
}

#[derive(Clone)]
enum VideoDeviceInfoInner {
    MediaFoundation {
        device: cap_camera_mediafoundation::Device,
        reader: cap_camera_mediafoundation::SourceReader,
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

#[derive(Debug)]
pub enum GetDevicesError {
    MFDeviceEnumerationFailed(windows_core::Error),
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

            let reader = device.create_source_reader()?;
            let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

            let formats = reader
                .native_media_types(stream_index)?
                .filter_map(|t| VideoFormat::new_mf(t).ok())
                .collect::<Vec<_>>();

            Ok::<_, windows_core::Error>(VideoDeviceInfo {
                name,
                id,
                model_id,
                formats,
                inner: VideoDeviceInfoInner::MediaFoundation { device, reader },
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
                .filter_map(|media_type| VideoFormat::new_ds(media_type).ok())
                .collect::<Vec<_>>();

            Some(VideoDeviceInfo {
                name,
                id,
                model_id,
                formats,
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
        f.write_str(&match self {
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
                _ => return None,
            })
        };

        Some(Self {
            format: get_ffmpeg()?,
            ds: subtype,
        })
    }
}
