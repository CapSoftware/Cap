fn main() {
    #[cfg(windows)]
    windows::main();
    #[cfg(not(windows))]
    panic!("This example is only available on Windows");
}

#[cfg(windows)]
mod windows {
    use cap_camera_directshow::*;
    use std::{fmt::Display, time::Duration};
    use tracing::error;
    use windows::{
        Win32::{
            Foundation::SIZE,
            Media::{DirectShow::*, MediaFoundation::*},
            System::Com::*,
        },
        core::Interface,
    };

    pub fn main() {
        tracing_subscriber::fmt::init();

        unsafe {
            CoInitialize(None).unwrap();

            let devices = VideoInputDeviceIterator::new().unwrap().collect::<Vec<_>>();

            let mut devices = devices
                .into_iter()
                .map(VideoDeviceSelectOption)
                .collect::<Vec<_>>();

            let selected = if devices.len() > 1 {
                inquire::Select::new("Select a device", devices)
                    .prompt()
                    .unwrap()
            } else {
                devices.remove(0)
            };

            let device = selected.0;

            let video_control = device.output_pin().cast::<IAMVideoControl>().ok();

            let formats = device
                .media_types()
                .unwrap()
                .enumerate()
                .filter_map(|(i, media_type)| {
                    let is_video = media_type.majortype == MEDIATYPE_Video
                        && media_type.formattype == FORMAT_VideoInfo;

                    if !is_video {
                        return None;
                    }

                    let video_info = &*media_type.video_info();

                    let width = video_info.bmiHeader.biWidth;
                    let height = video_info.bmiHeader.biHeight;

                    let mut frame_rates = vec![];

                    if let Some(video_control) = &video_control {
                        let time_per_frame_list = video_control.time_per_frame_list(
                            device.output_pin(),
                            i as i32,
                            SIZE {
                                cx: width,
                                cy: height,
                            },
                        );

                        for time_per_frame in time_per_frame_list {
                            if *time_per_frame <= 0 {
                                return None;
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

                    Some(Format {
                        width,
                        height,
                        media_type,
                        frame_rates,
                    })
                })
                .collect::<Vec<_>>();

            if formats.is_empty() {
                error!("No formats found");
                return;
            }

            let selected_format = inquire::Select::new("Select a format", formats)
                .prompt()
                .unwrap();

            device
                .start_capturing(
                    &selected_format.media_type,
                    Box::new(|frame| {
                        unsafe { dbg!(frame.sample.GetActualDataLength()) };
                        // dbg!(frame.media_type.subtype_str());
                        // dbg!(frame.reference_time);
                        dbg!(frame.timestamp);
                    }),
                )
                .unwrap();

            std::thread::sleep(Duration::from_secs(10));
        }
    }

    #[derive(Debug)]
    struct Format {
        width: i32,
        height: i32,
        media_type: AMMediaType,
        frame_rates: Vec<f64>,
    }

    impl Display for Format {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(
                f,
                "{}x{} {} ({:?})",
                self.width,
                self.height,
                unsafe {
                    self.media_type
                        .subtype_str()
                        .map(|v| v.to_string())
                        .unwrap_or(format!("unknown ({:?})", self.media_type.subtype))
                },
                &self.frame_rates
            )
        }
    }

    struct VideoDeviceSelectOption(VideoInputDevice);

    impl Display for VideoDeviceSelectOption {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{:?}", self.0.name().unwrap())
        }
    }
}
