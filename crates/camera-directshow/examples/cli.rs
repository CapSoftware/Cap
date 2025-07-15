use cap_camera_directshow::*;
use std::{fmt::Display, ptr::null_mut, time::Duration};
use tracing::{error, trace};
use windows::{
    Win32::{
        Foundation::SIZE,
        Media::{DirectShow::*, MediaFoundation::*},
        System::Com::{StructuredStorage::IPropertyBag, *},
    },
    core::Interface,
};
use windows_core::GUID;

fn main() {
    tracing_subscriber::fmt::init();

    unsafe {
        CoInitialize(None).unwrap();

        let devices = VideoInputDeviceEnumerator::new().unwrap().to_vec();

        let mut devices = devices
            .iter()
            .map(VideoDeviceSelectOption)
            .collect::<Vec<_>>();

        let selected = if devices.len() > 1 {
            inquire::Select::new("Select a device", devices)
                .prompt()
                .unwrap()
        } else {
            devices.remove(0)
        };

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

        chromium_main(filter);

        return;
    }
}

#[derive(Debug)]
struct Format {
    width: i32,
    height: i32,
    media_type: AM_MEDIA_TYPE,
    frame_rates: Vec<f64>,
}

impl Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}x{} {} ({:?})",
            self.width,
            self.height,
            unsafe { self.media_type.subtype_str().unwrap_or("unknown") },
            &self.frame_rates
        )
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

// chromium

unsafe fn chromium_main(capture_filter: IBaseFilter) {
    let output_capture_pin = capture_filter
        .get_pin(PINDIR_OUTPUT, PIN_CATEGORY_CAPTURE, GUID::zeroed())
        .unwrap();

    let stream_config = output_capture_pin.cast::<IAMStreamConfig>().unwrap();
    let video_control = output_capture_pin.cast::<IAMVideoControl>().ok();

    let mut media_types_iter = stream_config.media_types();

    // println!("Formats: {}", media_types_iter.count());

    let mut formats = Vec::with_capacity(media_types_iter.count() as usize);

    while let Some((media_type, i)) = media_types_iter.next() {
        let is_video =
            media_type.majortype == MEDIATYPE_Video && media_type.formattype == FORMAT_VideoInfo;

        if !is_video {
            continue;
        }

        // println!("Format {i}:");

        let video_info = &*media_type.video_info();

        let width = video_info.bmiHeader.biWidth;
        let height = video_info.bmiHeader.biHeight;

        // println!("  Dimensions: {width}x{height}");

        let subtype_str = media_type.subtype_str().unwrap_or("unknown subtype");

        // println!("  Pixel Format: {subtype_str}");

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

        // println!("  Frame Rates: {:?}", frame_rates);

        formats.push(Format {
            width,
            height,
            media_type: media_type.clone(),
            frame_rates,
        })
    }

    if formats.is_empty() {
        error!("No formats found");
        return;
    }

    let selected_format = inquire::Select::new("Select a format", formats)
        .prompt()
        .unwrap();

    stream_config
        .SetFormat(&selected_format.media_type)
        .unwrap();

    trace!("creating sink filter");
    let sink_filter = SinkFilter::new(Box::new(|buffer, media_type, time_delta| {
        dbg!(buffer.len());
        dbg!(media_type.subtype_str());
        dbg!(time_delta);
    }));
    trace!("created sink filter");

    let input_sink_pin = sink_filter.get_pin(0).unwrap();

    trace!("creating graph builder");
    let graph_builder: IGraphBuilder =
        CoCreateInstance(&CLSID_FilterGraph, None, CLSCTX_INPROC_SERVER).unwrap();
    trace!("created graph builder");
    trace!("creating capture graph builder");
    let capture_graph_builder: ICaptureGraphBuilder2 =
        CoCreateInstance(&CLSID_CaptureGraphBuilder2, None, CLSCTX_INPROC_SERVER).unwrap();
    trace!("created capture graph builder");
    trace!("creating media control");
    let media_control = graph_builder.cast::<IMediaControl>().unwrap();
    trace!("created media control");
    trace!("setting capture graph");
    capture_graph_builder
        .SetFiltergraph(&graph_builder)
        .unwrap();
    trace!("set capture graph");
    trace!("adding capture filter");
    graph_builder.AddFilter(&capture_filter, None).unwrap();
    trace!("added capture filter");
    trace!("creating sink filter");
    let sink_filter: IBaseFilter = sink_filter.cast().unwrap();
    trace!("adding sink filter");
    graph_builder.AddFilter(&sink_filter, None).unwrap();
    trace!("added sink filter");

    trace!("finding stream config");
    let mut stream_config = null_mut();
    capture_graph_builder
        .FindInterface(
            Some(&PIN_CATEGORY_CAPTURE),
            Some(&MEDIATYPE_Video),
            &capture_filter,
            &IAMStreamConfig::IID,
            &mut stream_config,
        )
        .unwrap();
    trace!("found stream config");

    graph_builder
        .ConnectDirect(&output_capture_pin, &input_sink_pin, None)
        .unwrap();

    media_control.Run().unwrap();

    std::thread::sleep(Duration::from_secs(10));
}
