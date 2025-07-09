use std::fmt::Display;

use cap_camera_dshow::*;
use windows::{
    core::Interface,
    Win32::{
        Foundation::SIZE,
        Media::{
            DirectShow::{IAMStreamConfig, IAMVideoControl, IBaseFilter, PINDIR_OUTPUT},
            MediaFoundation::{FORMAT_VideoInfo, MEDIATYPE_Video, PIN_CATEGORY_CAPTURE},
        },
        System::Com::{CoInitialize, IMoniker, StructuredStorage::IPropertyBag},
    },
};
use windows_core::GUID;

fn main() {
    unsafe {
        CoInitialize(None).unwrap();

        let mut video_device_enum = VideoInputDeviceEnumerator::new().unwrap();

        let devices = video_device_enum.to_vec();
        let devices = devices
            .iter()
            .map(VideoDeviceSelectOption)
            .collect::<Vec<_>>();

        let selected = inquire::Select::new("Select a device", devices)
            .prompt()
            .unwrap();

        let moniker = selected.0;

        let property_data: IPropertyBag = moniker.BindToStorage(None, None).unwrap();

        let device_name = property_data
            .read(windows_core::w!("FriendlyName"), None)
            .unwrap();

        let device_path = property_data
            .read(windows_core::w!("DevicePath"), None)
            .unwrap_or_default();

        let device_name = device_name.to_os_string().unwrap();
        println!("Info for device '{:?}'", device_name);

        let device_path = device_path.to_os_string();
        println!("Path: '{:?}'", device_path);

        let filter: IBaseFilter = moniker.BindToObject(None, None).unwrap();

        let output_capture_pin = filter
            .get_pin(PINDIR_OUTPUT, PIN_CATEGORY_CAPTURE, GUID::zeroed())
            .unwrap();

        let stream_config = output_capture_pin.cast::<IAMStreamConfig>().unwrap();
        let video_control = output_capture_pin.cast::<IAMVideoControl>().ok();

        let mut media_types_iter = stream_config.media_types();

        println!("Formats: {}", media_types_iter.count());

        while let Some((media_type, i)) = media_types_iter.next() {
            let is_video = media_type.majortype == MEDIATYPE_Video
                && media_type.formattype == FORMAT_VideoInfo;

            if !is_video {
                continue;
            }

            println!("Format {i}:");

            let video_info = &*media_type.video_info();

            let width = video_info.bmiHeader.biWidth;
            let height = video_info.bmiHeader.biHeight;

            println!("  Dimensions: {width}x{height}");

            let subtype_str = media_type.subtype_str().unwrap_or("unknown subtype");

            println!("  Pixel Format: {subtype_str}");

            let mut frame_rates = vec![];

            if let Some(video_control) = &video_control {
                let time_per_frame_list = video_control.time_per_frame_list(
                    &output_capture_pin,
                    i,
                    SIZE {
                        cx: width,
                        cy: height,
                    },
                );

                for time_per_frame in time_per_frame_list {
                    if *time_per_frame <= 0 {
                        continue;
                    }
                    frame_rates.push(10_000_000.0 / *time_per_frame as f64)
                }
            }

            if frame_rates.is_empty() {
                let frame_rate = 10_000_000.0 / video_info.AvgTimePerFrame as f64;
                frame_rates.push(frame_rate);
            }

            frame_rates
                .iter_mut()
                .for_each(|v| *v = (*v * 100.0).round() / 100.0);

            println!("  Frame Rates: {:?}", frame_rates);
        }
    }
}

struct VideoDeviceSelectOption<'a>(&'a IMoniker);

impl<'a> Display for VideoDeviceSelectOption<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let device_name = unsafe {
            let property_data: IPropertyBag = self.0.BindToStorage(None, None).unwrap();

            let device_name = property_data
                .read(windows_core::w!("FriendlyName"), None)
                .unwrap();

            device_name.to_os_string().unwrap()
        };

        write!(f, "{:?}", device_name)
    }
}
