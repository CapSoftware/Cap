fn main() {
    #[cfg(windows)]
    windows::main();
    #[cfg(not(windows))]
    panic!("This example is only available on Windows");
}

#[cfg(windows)]
mod windows {

    use std::{fmt::Display, time::Duration};

    use cap_camera_mediafoundation::DeviceSourcesIterator;
    use tracing::warn;
    use windows::Win32::{Media::MediaFoundation::*, System::Com::CoInitialize};
    use windows_core::GUID;

    pub fn main() {
        unsafe {
            CoInitialize(None).unwrap();

            let device_sources = DeviceSourcesIterator::new().unwrap();

            if device_sources.is_empty() {
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

            let mut formats = selected
                .formats()
                .unwrap()
                .filter_map(|v| VideoFormat::new(v).ok())
                .collect::<Vec<_>>();

            let selected_format = if formats.len() > 1 {
                inquire::Select::new("Select a format", formats)
                    .prompt()
                    .unwrap()
            } else {
                formats.remove(0)
            };

            let _handle = selected
                .start_capturing(
                    &selected_format.inner,
                    Box::new(|data| {
                        let pts = data.sample.GetSampleTime().unwrap();
                        let bytes = data.sample.GetTotalLength().unwrap();
                        // if stream_flags as i32 & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
                        //     == MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0
                        // {
                        //     selected_format =
                        //         VideoFormat::new(reader.GetCurrentMediaType(stream_index).unwrap()).unwrap();
                        // }
                        println!(
                            "New frame: {pts}pts, {bytes} bytes",
                            // selected_format.width,
                            // selected_format.height,
                            // media_subtype_str(&selected_format.subtype).unwrap_or("unknown format")
                        );
                    }),
                )
                .unwrap();

            std::thread::sleep(Duration::from_secs(10));
        }
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
}
