use std::{
    borrow::Cow,
    ffi::{OsStr, OsString},
    fmt::Display,
    mem::MaybeUninit,
    ops::{Deref, DerefMut},
    os::windows::ffi::{OsStrExt, OsStringExt},
    slice::{self, from_raw_parts},
    time::Duration,
};

use tracing::warn;
use windows::Win32::{Media::MediaFoundation::*, System::Com::CoInitialize};
use windows_core::{GUID, Interface};
use windows_core::{PCWSTR, PWSTR};

pub fn main() {
    std::thread::spawn(|| unsafe {
        CoInitialize(None).unwrap();

        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 1).unwrap();
        let attributes = attributes.unwrap();

        attributes
            .SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )
            .unwrap();

        let mut count = 0;
        let mut devices: MaybeUninit<*mut Option<IMFActivate>> = MaybeUninit::uninit();

        MFEnumDeviceSources(&attributes, devices.as_mut_ptr(), &mut count).unwrap();

        if count == 0 {
            warn!("No devices found");
            return;
        }

        let devices = devices.assume_init();

        let mut device_list = vec![];

        for i in 0..count {
            let Some(device) = &mut *devices.add(i as usize) else {
                continue;
            };

            let mut name_raw = PWSTR(&mut 0);
            let mut name_length = 0;
            device
                .GetAllocatedString(
                    &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                    &mut name_raw,
                    &mut name_length,
                )
                .unwrap();
            let name = OsString::from_wide(from_raw_parts(name_raw.0, name_length as usize));

            let mut id_raw = PWSTR(&mut 0);
            let mut id_length = 0;
            device
                .GetAllocatedString(
                    &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                    &mut id_raw,
                    &mut id_length,
                )
                .unwrap();
            let id = OsString::from_wide(from_raw_parts(id_raw.0, id_length as usize));

            let device = device.ActivateObject::<IMFMediaSource>().unwrap();

            device_list.push(Device {
                device,
                id_raw,
                name_raw,
                id,
                name,
            })
        }

        let selected = if device_list.len() > 1 {
            inquire::Select::new("Select a device", device_list)
                .prompt()
                .unwrap()
        } else {
            device_list.remove(0)
        };

        let reader = MFCreateSourceReaderFromMediaSource(&selected.device, None).unwrap();
        let mut stream_index = 0;

        let mut formats = vec![];

        while let Ok(typ) =
            reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, stream_index)
        {
            let format = Format::new(typ).unwrap();
            formats.push(format);

            stream_index += 1;
        }

        let mut selected_format = if formats.len() > 1 {
            inquire::Select::new("Select a format", formats)
                .prompt()
                .unwrap()
        } else {
            formats.remove(0)
        };

        reader
            .SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                None,
                &selected_format.inner,
            )
            .unwrap();

        reader
            .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
            .unwrap();

        let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        loop {
            let mut imf_sample = None;
            let mut stream_flags = 0;
            let imf_sample = loop {
                reader
                    .ReadSample(
                        stream_index,
                        0,
                        None,
                        Some(&mut stream_flags),
                        None,
                        Some(&mut imf_sample),
                    )
                    .unwrap();

                if let Some(imf_sample) = imf_sample {
                    break imf_sample;
                }
            };

            let pts = imf_sample.GetSampleTime().unwrap();
            let bytes = imf_sample.GetTotalLength().unwrap();
            if stream_flags as i32 & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
                == MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
            {
                selected_format =
                    Format::new(reader.GetCurrentMediaType(stream_index).unwrap()).unwrap();
            }

            println!(
                "New frame: {}x{}, {pts}pts, {bytes} bytes, {}",
                selected_format.width,
                selected_format.height,
                media_subtype_str(&selected_format.subtype).unwrap_or("unknown format")
            );
        }
    });

    std::thread::sleep(Duration::from_secs(10));
}

struct Device {
    device: IMFMediaSource,
    id_raw: PWSTR,
    name_raw: PWSTR,
    id: OsString,
    name: OsString,
}

impl Device {
    fn device_id(&self) -> String {
        self.id.to_string_lossy().to_string()
    }

    fn display_name(&self) -> String {
        self.name.to_string_lossy().to_string()
    }

    fn model_id(&self) -> String {
        get_device_model_id(&self.device_id())
    }
}

impl Deref for Device {
    type Target = IMFMediaSource;

    fn deref(&self) -> &Self::Target {
        &self.device
    }
}

impl DerefMut for Device {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.device
    }
}

impl Display for Device {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.display_name())
    }
}

struct Format {
    inner: IMFMediaType,
    width: u32,
    height: u32,
    frame_rate_ratio: (u32, u32),
    frame_rate: f32,
    subtype: GUID,
}

impl Format {
    fn new(inner: IMFMediaType) -> windows_core::Result<Self> {
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
            inner,
            width,
            height,
            frame_rate_ratio,
            frame_rate,
            subtype,
        })
    }
}

impl Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}x{} {}fps", self.width, self.height, self.frame_rate)?;
        if self.frame_rate_ratio.1 != 1 {
            write!(
                f,
                " ({}/{})",
                self.frame_rate_ratio.0, self.frame_rate_ratio.1
            )?
        }
        write!(
            f,
            " {}",
            media_subtype_str(&self.subtype).unwrap_or("unknown format")
        )
    }
}

fn get_device_model_id(device_id: &str) -> String {
    const VID_PID_SIZE: usize = 4;

    let vid_location = device_id.find("vid_");
    let pid_location = device_id.find("pid_");

    let Some(vid_location) = vid_location else {
        return String::new();
    };
    let Some(pid_location) = pid_location else {
        return String::new();
    };

    if vid_location + "vid_".len() + 4 > device_id.len()
        || pid_location + "pid_".len() + 4 > device_id.len()
    {
        return String::new();
    }

    let id_vendor = &device_id[vid_location + 4..vid_location + 8];
    let id_product = &device_id[pid_location + 4..pid_location + 8];

    format!("{id_vendor}:{id_product}")
}

fn media_subtype_str(subtype: &GUID) -> Option<&'static str> {
    Some(match *subtype {
        t if t == MFVideoFormat_I420 => "i420",
        t if t == MFVideoFormat_IYUV => "iyuv",
        t if t == MFVideoFormat_RGB24 => "rgb24",
        t if t == MFVideoFormat_RGB32 => "rgb32",
        t if t == MFVideoFormat_YUY2 => "yuy2",
        t if t == MFVideoFormat_MJPG => "mjpg",
        t if t == MFVideoFormat_UYVY => "uyvy",
        t if t == MFVideoFormat_ARGB32 => "argb32",
        t if t == MFVideoFormat_NV12 => "nv12",
        t if t == MFVideoFormat_H264 => "h264",
        _ => return None,
    })
}
