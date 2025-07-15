use std::{fmt::Display, time::Duration};

use camera_mediafoundation::DeviceSourcesIterator;
use tracing::warn;
use windows::Win32::{Media::MediaFoundation::*, System::Com::CoInitialize};
use windows_core::GUID;

pub fn main() {
    std::thread::spawn(|| unsafe {
        CoInitialize(None).unwrap();

        let device_sources = DeviceSourcesIterator::new().unwrap();

        if device_sources.len() == 0 {
            warn!("No devices found");
            return;
        }

        let mut device_list = device_sources.collect::<Vec<_>>();

        let selected = if device_list.len() > 1 {
            inquire::Select::new("Select a device", device_list)
                .prompt()
                .unwrap()
        } else {
            device_list.remove(0)
        };

        let Ok(reader) = selected.create_source_reader() else {
            return;
        };

        let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

        let mut formats = reader
            .native_media_types(stream_index)
            .into_iter()
            .filter_map(|v| VideoFormat::new(v).ok())
            .collect::<Vec<_>>();

        let mut selected_format = if formats.len() > 1 {
            inquire::Select::new("Select a format", formats)
                .prompt()
                .unwrap()
        } else {
            formats.remove(0)
        };

        reader
            .set_current_media_type(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                &selected_format.inner,
            )
            .unwrap();

        reader.SetStreamSelection(stream_index, true).unwrap();

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
                    VideoFormat::new(reader.GetCurrentMediaType(stream_index).unwrap()).unwrap();
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

struct VideoFormat {
    inner: IMFMediaType,
    width: u32,
    height: u32,
    frame_rate_ratio: (u32, u32),
    frame_rate: f32,
    subtype: GUID,
}

impl VideoFormat {
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

impl Display for VideoFormat {
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
